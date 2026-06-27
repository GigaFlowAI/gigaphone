/**
 * Unit tests for the v1 lexical Rust language pack.
 *
 * Proves the pack loads, discovery finds a hand-rolled gateway + a `match`-based tool
 * dispatch, analyze classifies untraced / off_context / lossy against Rust's concurrency
 * model (`tokio::spawn` / thread pools / the `tracing` crate), and emitFix is byte-accurate
 * + idempotent. Like the TypeScript pack, Rust is not run e2e (only Python is); these tests
 * exercise it structurally and mirror `test_typescript_pack.py`.
 */

import { describe, expect, it } from "vitest";
import { BoundaryKind, FailureMode } from "../src/core/boundary.js";
import type { Boundary, CodeEdit, FixPrimitive } from "../src/core/model.js";
import { RustPack } from "../src/packs/rust/pack.js";

const PATH = "src/agent.rs";

const FIXTURE = `//! Acme Rust agent — hand-rolled gateway, tools, and a thread pool.
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
`;

/**
 * Idempotent multi-hunk applier mirroring engine.fix._apply_hunks: all hunks are computed
 * against one snapshot and applied in a single pass, descending by offset, so earlier offsets
 * stay valid. A hunk whose tag already occurs is skipped.
 */
function applyEdits(source: string, ...edits: CodeEdit[]): string {
  let data = Buffer.from(source, "utf-8");
  const hunks = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    for (const h of edit.hunks) {
      if (source.includes(h.tag) || seen.has(h.tag)) {
        continue;
      }
      seen.add(h.tag);
      hunks.push(h);
    }
  }
  hunks.sort((a, b) => b.byteStart - a.byteStart);
  for (const h of hunks) {
    data = Buffer.concat([
      data.subarray(0, h.byteStart),
      Buffer.from(h.newText, "utf-8"),
      data.subarray(h.byteEnd),
    ]);
  }
  return data.toString("utf-8");
}

/**
 * A Rust-flavoured OTel/`tracing` primitive (the python OtelAdapter is not wired to this
 * pack). UNTRACED renders an attribute macro, OFF_CONTEXT a span-propagating wrapper,
 * LOSSY_OUTPUT a complete-output recorder.
 */
function primitive(mode: FailureMode, boundary: Boundary): FixPrimitive {
  if (mode === FailureMode.UNTRACED) {
    const fields = boundary.completeOutputFields.map((f) => `"${f}"`).join(", ");
    return {
      failureMode: mode,
      backendId: "otel",
      importLine: "use gigaphone_otel::gigaphone_trace;",
      emitName: boundary.emitName || boundary.funcName,
      outputFields: [...boundary.completeOutputFields],
      decorator: `gigaphone_trace(name = "${boundary.emitName}", output = [${fields}])`,
    };
  }
  if (mode === FailureMode.OFF_CONTEXT) {
    return {
      failureMode: mode,
      backendId: "otel",
      importLine: "use gigaphone_otel::gigaphone_propagate;",
      emitName: boundary.existingSpanName || boundary.funcName,
      executorWrapper: "gigaphone_propagate",
    };
  }
  return {
    failureMode: mode,
    backendId: "otel",
    importLine: "use gigaphone_otel::gigaphone_complete;",
    emitName: boundary.existingSpanName || boundary.funcName,
    outputFields: [...boundary.completeOutputFields],
    attrSetterTemplate: "gigaphone_complete(&{span}, {value}, {fields});",
  };
}

describe("RustPack", () => {
  it("test_pack_loads", () => {
    const pack = new RustPack();
    expect(pack.id).toBe("rust");
    expect(pack.extensions).toEqual([".rs"]);
  });

  it("test_discovery_finds_gateway_and_tools", () => {
    const descs = new Map(new RustPack().discover(PATH, FIXTURE).map((d) => [d.matchCall, d]));
    const gw = descs.get("agent.LlmGateway.chat");
    expect(gw !== undefined && gw.kind === BoundaryKind.LLM).toBe(true);
    const tools = new Set(
      [...descs.entries()].filter(([, d]) => d.kind === BoundaryKind.TOOL_EXEC).map(([c]) => c),
    );
    expect(tools.has("agent.run_code")).toBe(true);
    expect(tools.has("agent.web_search")).toBe(true);
    expect(tools.has("agent.fetch_url")).toBe(true);
  });

  it("test_analyze_classifies_failure_modes", () => {
    const pack = new RustPack();
    const descs = pack.discover(PATH, FIXTURE);
    const bs = new Map(pack.analyze(PATH, FIXTURE, descs).map((b) => [b.funcName, b]));

    expect(bs.get("run_code")!.failureModes).toEqual([FailureMode.UNTRACED]);
    expect(bs.get("run_code")!.completeOutputFields).toEqual(["stdout", "stderr", "exit_code"]);
    expect(bs.get("fetch_url")!.failureModes).toEqual([FailureMode.OFF_CONTEXT]);
    expect(bs.get("web_search")!.failureModes).toEqual([FailureMode.LOSSY_OUTPUT]);
    expect(bs.get("chat")!.failureModes).toEqual([]); // gateway already traced -> covered
  });

  it("test_emit_fix_is_byte_accurate_and_idempotent", () => {
    const pack = new RustPack();
    const descs = pack.discover(PATH, FIXTURE);

    let fixed = FIXTURE;
    for (let pass = 0; pass < 3; pass++) {
      // converge: collect edits vs one snapshot, apply once per pass
      const bs = pack.analyze(PATH, fixed, descs);
      const edits: Array<CodeEdit | null> = [];
      for (const b of bs) {
        for (const mode of b.failureModes) {
          edits.push(pack.emitFix(b, primitive(mode, b), fixed));
        }
      }
      expect(edits.every((e) => e !== null)).toBe(true);
      if (edits.length === 0) {
        break;
      }
      fixed = applyEdits(fixed, ...(edits as CodeEdit[]));
    }

    // the fix is present and the result is valid (balanced braces) ...
    expect(fixed.includes("gigaphone_trace(")).toBe(true);
    expect(fixed.includes("gigaphone_propagate(ThreadPool::new(4))")).toBe(true);
    expect(fixed.includes("gigaphone_complete(")).toBe(true);
    expect(count(fixed, "{")).toBe(count(fixed, "}"));

    // ... and re-analyzing the fixed source reports every boundary covered (idempotent)
    const reb = pack.analyze(PATH, fixed, descs);
    expect(reb.every((b) => b.failureModes.length === 0)).toBe(true);

    // applying the fixes once more changes nothing
    const leftover: CodeEdit[] = [];
    for (const b of pack.analyze(PATH, fixed, descs)) {
      for (const mode of b.failureModes) {
        leftover.push(pack.emitFix(b, primitive(mode, b), fixed)!);
      }
    }
    expect(applyEdits(fixed, ...leftover)).toBe(fixed);
  });

  it("test_emit_fix_untraced_inserts_marker_and_import", () => {
    const pack = new RustPack();
    const descs = pack.discover(PATH, FIXTURE);
    const run = pack.analyze(PATH, FIXTURE, descs).find((b) => b.funcName === "run_code")!;
    const edit = pack.emitFix(run, primitive(FailureMode.UNTRACED, run), FIXTURE);
    expect(edit).not.toBeNull();
    const tags = new Set(edit!.hunks.map((h) => h.tag));
    expect(tags.has("gigaphone:trace:run_code")).toBe(true);
    // idempotent: a hunk whose tag already exists is dropped by the applier
    const once = applyEdits(FIXTURE, edit!);
    const twice = applyEdits(once, pack.emitFix(run, primitive(FailureMode.UNTRACED, run), once)!);
    expect(once).toBe(twice);
    expect(typeof edit!.hunks[0]!.byteStart).toBe("number");
  });
});

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) {
    if (c === ch) {
      n += 1;
    }
  }
  return n;
}
