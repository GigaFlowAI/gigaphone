"""Unit tests for the v1 lexical Rust language pack.

Proves the pack loads, discovery finds a hand-rolled gateway + a `match`-based tool
dispatch, analyze classifies untraced / off_context / lossy against Rust's concurrency
model (`tokio::spawn` / thread pools / the `tracing` crate), and emit_fix is byte-accurate
+ idempotent. Like the TypeScript pack, Rust is not run e2e (only Python is); these tests
exercise it structurally and mirror ``test_typescript_pack.py``.
"""

from __future__ import annotations

from gigaphone.core.boundary import BoundaryKind, FailureMode
from gigaphone.core.model import FixPrimitive, Hunk
from gigaphone.packs.rust import RustPack

PATH = "src/agent.rs"

FIXTURE = """\
//! Acme Rust agent — hand-rolled gateway, tools, and a thread pool.
use tracing::info_span;
use std::process::Command;

struct LlmGateway;

impl LlmGateway {
    async fn chat(&self, messages: Vec<Message>) -> Message {
        let span = info_span!("llm");
        let _enter = span.enter();
        self.plan(messages)
    }
}

fn run_code(code: &str) -> ExecResult {
    let out = Command::new("sh").arg("-c").arg(code).output().unwrap();
    let stdout = String::from_utf8(out.stdout).unwrap();
    ExecResult { stdout, stderr: String::new(), exit_code: 0 }
}

fn web_search(query: &str) -> SearchResult {
    let results = do_search(query);
    let summary = serde_json::to_string(&results).unwrap();
    let span = info_span!("web_search");
    let _enter = span.enter();
    span.record("tool.output", &summary[..60]);
    results
}

fn fetch_url(url: &str) -> String {
    let pool = ThreadPool::new(4);
    pool.spawn(move || {
        let span = info_span!("fetch_url");
        let _enter = span.enter();
        let body = http_get(url);
        span.record("tool.output", &body);
        body
    })
}

fn dispatch(name: &str, arg: &str) -> String {
    match name {
        "run_code" => run_code(arg),
        "web_search" => web_search(arg),
        "fetch_url" => fetch_url(arg),
        _ => String::new(),
    }
}
"""


def _apply(source: str, *edits) -> str:
    """Idempotent multi-hunk applier mirroring engine.fix._apply_hunks: all hunks are
    computed against one snapshot and applied in a single pass, descending by offset, so
    earlier offsets stay valid. A hunk whose tag already occurs is skipped."""
    data = source.encode("utf-8")
    hunks = []
    seen: set[str] = set()
    for edit in edits:
        for h in edit.hunks:
            if h.tag in source or h.tag in seen:
                continue
            seen.add(h.tag)
            hunks.append(h)
    for h in sorted(hunks, key=lambda x: x.byte_start, reverse=True):
        data = data[: h.byte_start] + h.new_text.encode("utf-8") + data[h.byte_end :]
    return data.decode("utf-8")


def _primitive(mode: FailureMode, boundary) -> FixPrimitive:
    """A Rust-flavoured OTel/`tracing` primitive (the python OtelAdapter is not wired to
    this pack). UNTRACED renders an attribute macro, OFF_CONTEXT a span-propagating wrapper,
    LOSSY_OUTPUT a complete-output recorder."""
    if mode == FailureMode.UNTRACED:
        fields = ", ".join(f'"{f}"' for f in boundary.complete_output_fields)
        return FixPrimitive(
            failure_mode=mode,
            backend_id="otel",
            import_line="use gigaphone_otel::gigaphone_trace;",
            emit_name=boundary.emit_name or boundary.func_name,
            output_fields=tuple(boundary.complete_output_fields),
            decorator=f'gigaphone_trace(name = "{boundary.emit_name}", output = [{fields}])',
        )
    if mode == FailureMode.OFF_CONTEXT:
        return FixPrimitive(
            failure_mode=mode,
            backend_id="otel",
            import_line="use gigaphone_otel::gigaphone_propagate;",
            emit_name=boundary.existing_span_name or boundary.func_name,
            executor_wrapper="gigaphone_propagate",
        )
    return FixPrimitive(
        failure_mode=mode,
        backend_id="otel",
        import_line="use gigaphone_otel::gigaphone_complete;",
        emit_name=boundary.existing_span_name or boundary.func_name,
        output_fields=tuple(boundary.complete_output_fields),
        attr_setter_template="gigaphone_complete(&{span}, {value}, {fields});",
    )


def test_pack_loads():
    pack = RustPack()
    assert pack.id == "rust"
    assert pack.extensions == (".rs",)


def test_discovery_finds_gateway_and_tools():
    descs = {d.match_call: d for d in RustPack().discover(PATH, FIXTURE)}
    gw = descs.get("agent.LlmGateway.chat")
    assert gw is not None and gw.kind == BoundaryKind.LLM
    tools = {c for c, d in descs.items() if d.kind == BoundaryKind.TOOL_EXEC}
    assert "agent.run_code" in tools
    assert "agent.web_search" in tools
    assert "agent.fetch_url" in tools


def test_analyze_classifies_failure_modes():
    pack = RustPack()
    descs = pack.discover(PATH, FIXTURE)
    bs = {b.func_name: b for b in pack.analyze(PATH, FIXTURE, descs)}

    assert bs["run_code"].failure_modes == [FailureMode.UNTRACED]
    assert bs["run_code"].complete_output_fields == ["stdout", "stderr", "exit_code"]
    assert bs["fetch_url"].failure_modes == [FailureMode.OFF_CONTEXT]
    assert bs["web_search"].failure_modes == [FailureMode.LOSSY_OUTPUT]
    assert bs["chat"].failure_modes == []  # gateway already traced -> covered


def test_emit_fix_is_byte_accurate_and_idempotent():
    pack = RustPack()
    descs = pack.discover(PATH, FIXTURE)

    fixed = FIXTURE
    for _ in range(3):  # converge: collect edits vs one snapshot, apply once per pass
        bs = pack.analyze(PATH, fixed, descs)
        edits = [
            pack.emit_fix(b, _primitive(mode, b), fixed) for b in bs for mode in b.failure_modes
        ]
        assert all(e is not None for e in edits)
        if not edits:
            break
        fixed = _apply(fixed, *edits)

    # the fix is present and the result is valid (balanced braces) ...
    assert "gigaphone_trace(" in fixed
    assert "gigaphone_propagate(ThreadPool::new(4))" in fixed
    assert "gigaphone_complete(" in fixed
    assert fixed.count("{") == fixed.count("}")

    # ... and re-analyzing the fixed source reports every boundary covered (idempotent)
    reb = {b.func_name: b for b in pack.analyze(PATH, fixed, descs)}
    assert all(not b.failure_modes for b in reb.values())

    # applying the fixes once more changes nothing
    leftover = [
        pack.emit_fix(b, _primitive(mode, b), fixed)
        for b in pack.analyze(PATH, fixed, descs)
        for mode in b.failure_modes
    ]
    assert _apply(fixed, *leftover) == fixed


def test_emit_fix_untraced_inserts_marker_and_import():
    pack = RustPack()
    descs = pack.discover(PATH, FIXTURE)
    run = next(b for b in pack.analyze(PATH, FIXTURE, descs) if b.func_name == "run_code")
    edit = pack.emit_fix(run, _primitive(FailureMode.UNTRACED, run), FIXTURE)
    assert edit is not None
    tags = {h.tag for h in edit.hunks}
    assert "gigaphone:trace:run_code" in tags
    # idempotent: a hunk whose tag already exists is dropped by the applier
    once = _apply(FIXTURE, edit)
    twice = _apply(once, pack.emit_fix(run, _primitive(FailureMode.UNTRACED, run), once))
    assert once == twice
    assert isinstance(edit.hunks[0], Hunk)
