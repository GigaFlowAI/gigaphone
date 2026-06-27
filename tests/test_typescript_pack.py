"""Unit tests for the v1 lexical TypeScript language pack.

Proves the pack loads, discovery finds a hand-rolled gateway + tool registry, analyze
classifies untraced / off_context / lossy, and emit_fix is byte-accurate + idempotent.
These tests exercise the pack structurally; the full discover->fix->verify wire path (with
the real backend adapter + a live Node run) is covered by ``test_e2e_typescript_onboarding``.
"""

from __future__ import annotations

from gigaphone.core.boundary import BoundaryKind, FailureMode
from gigaphone.core.model import FixPrimitive, Hunk
from gigaphone.packs.typescript import TypeScriptPack

PATH = "app/agent.ts"

FIXTURE = """\
/**
 * Acme TS agent — hand-rolled gateway, tools, and a worker pool.
 */
import { trace } from "@opentelemetry/api";

export class LLMGateway {
  async chat(messages: Message[]): Promise<Message> {
    const span = trace.getTracer("acme").startSpan("llm");
    const reply = this.plan(messages);
    span.end();
    return reply;
  }
}

export function runCode(code: string): ExecResult {
  const out = execSync(code, { encoding: "utf-8" });
  return { stdout: out, stderr: "", exitCode: 0 };
}

export function webSearch(query: string): SearchResult {
  const results = doSearch(query);
  const summary = JSON.stringify(results);
  const span = trace.getTracer("acme").startSpan("web_search");
  span.setAttribute("tool.output", summary.slice(0, 60));
  span.end();
  return results;
}

const pool = new WorkerPool(4);

export function fetchUrl(url: string): string {
  return pool.run(() => {
    const span = trace.getTracer("acme").startSpan("fetch_url");
    const body = httpGet(url);
    span.setAttribute("tool.output", body);
    span.end();
    return body;
  });
}

export const TOOLS: Record<string, Function> = {
  run_code: runCode,
  web_search: webSearch,
  fetch_url: fetchUrl,
};
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
    """A TS-flavoured OTel primitive. The real ``OtelAdapter.primitive_for(..., "typescript")``
    now renders these (see ``test_typescript_fix_wiring``); this local copy keeps the pack's
    placement tests independent of the backend."""
    if mode == FailureMode.UNTRACED:
        fields = ", ".join(repr(f) for f in boundary.complete_output_fields)
        return FixPrimitive(
            failure_mode=mode,
            backend_id="otel",
            import_line='import { gigaphoneTrace } from "@gigaphone/otel";',
            emit_name=boundary.emit_name or boundary.func_name,
            output_fields=tuple(boundary.complete_output_fields),
            decorator=f'gigaphoneTrace({{ name: "{boundary.emit_name}", output: [{fields}] }})',
        )
    if mode == FailureMode.OFF_CONTEXT:
        return FixPrimitive(
            failure_mode=mode,
            backend_id="otel",
            import_line='import { gigaphonePropagate } from "@gigaphone/otel";',
            emit_name=boundary.existing_span_name or boundary.func_name,
            executor_wrapper="gigaphonePropagate",
        )
    return FixPrimitive(
        failure_mode=mode,
        backend_id="otel",
        import_line='import { gigaphoneComplete } from "@gigaphone/otel";',
        emit_name=boundary.existing_span_name or boundary.func_name,
        output_fields=tuple(boundary.complete_output_fields),
        attr_setter_template="gigaphoneComplete({span}, {value}, {fields});",
    )


def test_pack_loads():
    pack = TypeScriptPack()
    assert pack.id == "typescript"
    assert pack.extensions == (".ts", ".tsx")


def test_discovery_finds_gateway_and_tools():
    descs = {d.match_call: d for d in TypeScriptPack().discover(PATH, FIXTURE)}
    gw = descs.get("app.agent.LLMGateway.chat")
    assert gw is not None and gw.kind == BoundaryKind.LLM
    tools = {c for c, d in descs.items() if d.kind == BoundaryKind.TOOL_EXEC}
    assert "app.agent.runCode" in tools
    assert "app.agent.webSearch" in tools
    assert "app.agent.fetchUrl" in tools


def test_analyze_classifies_failure_modes():
    pack = TypeScriptPack()
    descs = pack.discover(PATH, FIXTURE)
    bs = {b.func_name: b for b in pack.analyze(PATH, FIXTURE, descs)}

    assert bs["runCode"].failure_modes == [FailureMode.UNTRACED]
    assert bs["runCode"].complete_output_fields == ["stdout", "stderr", "exitCode"]
    assert bs["fetchUrl"].failure_modes == [FailureMode.OFF_CONTEXT]
    assert bs["webSearch"].failure_modes == [FailureMode.LOSSY_OUTPUT]
    assert bs["chat"].failure_modes == []  # gateway already traced -> covered


def test_emit_fix_is_byte_accurate_and_idempotent():
    pack = TypeScriptPack()
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
    assert "gigaphoneTrace(" in fixed
    assert "gigaphonePropagate(new WorkerPool(4))" in fixed
    assert "gigaphoneComplete(" in fixed
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
    pack = TypeScriptPack()
    descs = pack.discover(PATH, FIXTURE)
    run = next(b for b in pack.analyze(PATH, FIXTURE, descs) if b.func_name == "runCode")
    edit = pack.emit_fix(run, _primitive(FailureMode.UNTRACED, run), FIXTURE)
    assert edit is not None
    tags = {h.tag for h in edit.hunks}
    assert "gigaphone:trace:runCode" in tags
    # idempotent: a hunk whose tag already exists is dropped by the applier
    once = _apply(FIXTURE, edit)
    twice = _apply(once, pack.emit_fix(run, _primitive(FailureMode.UNTRACED, run), once))
    assert once == twice
    assert isinstance(edit.hunks[0], Hunk)
