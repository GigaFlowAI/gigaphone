/**
 * Unit tests for the TypeScript language pack (ported from tests/test_typescript_pack.py).
 *
 * Proves the pack loads, discovery finds a hand-rolled gateway + tool registry, analyze
 * classifies untraced / off_context / lossy, and emit_fix is byte-accurate + idempotent.
 * These tests exercise the pack structurally and call it directly (no engine).
 */

import { describe, expect, it } from "vitest";
import { BoundaryKind, FailureMode } from "../src/core/boundary.js";
import type { Boundary, CodeEdit, FixPrimitive } from "../src/core/model.js";
import { TypeScriptPack } from "../src/packs/typescript/pack.js";

const PATH = "app/agent.ts";

const FIXTURE = `/**
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
`;

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

/**
 * Idempotent multi-hunk applier mirroring engine.fix._apply_hunks: all hunks are computed
 * against one snapshot and applied in a single pass, descending by offset. A hunk whose tag
 * already occurs is skipped.
 */
function applyEdits(source: string, ...edits: Array<CodeEdit | null>): string {
  let data = _encoder.encode(source);
  const hunks: Array<{ byteStart: number; byteEnd: number; newText: string; tag: string }> = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    if (!edit) continue;
    for (const h of edit.hunks) {
      if (source.includes(h.tag) || seen.has(h.tag)) continue;
      seen.add(h.tag);
      hunks.push(h);
    }
  }
  hunks.sort((a, b) => b.byteStart - a.byteStart);
  for (const h of hunks) {
    const insert = _encoder.encode(h.newText);
    const next = new Uint8Array(data.length - (h.byteEnd - h.byteStart) + insert.length);
    next.set(data.subarray(0, h.byteStart), 0);
    next.set(insert, h.byteStart);
    next.set(data.subarray(h.byteEnd), h.byteStart + insert.length);
    data = next;
  }
  return _decoder.decode(data);
}

/** A TS-flavoured OTel primitive (mirrors the Python test's local copy). */
function primitive(mode: FailureMode, boundary: Boundary): FixPrimitive {
  const repr = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (mode === FailureMode.UNTRACED) {
    const fields = boundary.completeOutputFields.map(repr).join(", ");
    return {
      failureMode: mode,
      backendId: "otel",
      importLine: 'import { gigaphoneTrace } from "@gigaphone/otel";',
      emitName: boundary.emitName ?? boundary.funcName,
      outputFields: [...boundary.completeOutputFields],
      decorator: `gigaphoneTrace({ name: "${boundary.emitName}", output: [${fields}] })`,
    };
  }
  if (mode === FailureMode.OFF_CONTEXT) {
    return {
      failureMode: mode,
      backendId: "otel",
      importLine: 'import { gigaphonePropagate } from "@gigaphone/otel";',
      emitName: boundary.existingSpanName ?? boundary.funcName,
      executorWrapper: "gigaphonePropagate",
    };
  }
  return {
    failureMode: mode,
    backendId: "otel",
    importLine: 'import { gigaphoneComplete } from "@gigaphone/otel";',
    emitName: boundary.existingSpanName ?? boundary.funcName,
    outputFields: [...boundary.completeOutputFields],
    attrSetterTemplate: "gigaphoneComplete({span}, {value}, {fields});",
  };
}

describe("TypeScriptPack", () => {
  it("loads", () => {
    const pack = new TypeScriptPack();
    expect(pack.id).toBe("typescript");
    expect(pack.extensions).toEqual([".ts", ".tsx"]);
  });

  it("discovery finds gateway and tools", () => {
    const descs = new Map(
      new TypeScriptPack().discover(PATH, FIXTURE).map((d) => [d.matchCall, d]),
    );
    const gw = descs.get("app.agent.LLMGateway.chat");
    expect(gw).toBeDefined();
    expect(gw?.kind).toBe(BoundaryKind.LLM);
    const tools = new Set(
      [...descs.values()].filter((d) => d.kind === BoundaryKind.TOOL_EXEC).map((d) => d.matchCall),
    );
    expect(tools.has("app.agent.runCode")).toBe(true);
    expect(tools.has("app.agent.webSearch")).toBe(true);
    expect(tools.has("app.agent.fetchUrl")).toBe(true);
  });

  it("analyze classifies failure modes", () => {
    const pack = new TypeScriptPack();
    const descs = pack.discover(PATH, FIXTURE);
    const bs = new Map(pack.analyze(PATH, FIXTURE, descs).map((b) => [b.funcName, b]));

    expect(bs.get("runCode")?.failureModes).toEqual([FailureMode.UNTRACED]);
    expect(bs.get("runCode")?.completeOutputFields).toEqual(["stdout", "stderr", "exitCode"]);
    expect(bs.get("fetchUrl")?.failureModes).toEqual([FailureMode.OFF_CONTEXT]);
    expect(bs.get("webSearch")?.failureModes).toEqual([FailureMode.LOSSY_OUTPUT]);
    expect(bs.get("chat")?.failureModes).toEqual([]); // gateway already traced -> covered
  });

  it("emit_fix is byte-accurate and idempotent", () => {
    const pack = new TypeScriptPack();
    const descs = pack.discover(PATH, FIXTURE);

    let fixed = FIXTURE;
    for (let pass = 0; pass < 3; pass++) {
      const bs = pack.analyze(PATH, fixed, descs);
      const edits: Array<CodeEdit | null> = [];
      for (const b of bs) {
        for (const mode of b.failureModes) {
          edits.push(pack.emitFix(b, primitive(mode, b), fixed));
        }
      }
      expect(edits.every((e) => e !== null)).toBe(true);
      if (edits.length === 0) break;
      fixed = applyEdits(fixed, ...edits);
    }

    // the fix is present and the result is valid (balanced braces) ...
    expect(fixed.includes("gigaphoneTrace(")).toBe(true);
    expect(fixed.includes("gigaphonePropagate(new WorkerPool(4))")).toBe(true);
    expect(fixed.includes("gigaphoneComplete(")).toBe(true);
    expect(count(fixed, "{")).toBe(count(fixed, "}"));

    // ... and re-analyzing the fixed source reports every boundary covered (idempotent)
    const reb = pack.analyze(PATH, fixed, descs);
    expect(reb.every((b) => b.failureModes.length === 0)).toBe(true);

    // applying the fixes once more changes nothing
    const leftover: Array<CodeEdit | null> = [];
    for (const b of pack.analyze(PATH, fixed, descs)) {
      for (const mode of b.failureModes) {
        leftover.push(pack.emitFix(b, primitive(mode, b), fixed));
      }
    }
    expect(applyEdits(fixed, ...leftover)).toBe(fixed);
  });

  it("emit_fix untraced inserts marker and import", () => {
    const pack = new TypeScriptPack();
    const descs = pack.discover(PATH, FIXTURE);
    const run = pack.analyze(PATH, FIXTURE, descs).find((b) => b.funcName === "runCode");
    expect(run).toBeDefined();
    if (!run) return;
    const edit = pack.emitFix(run, primitive(FailureMode.UNTRACED, run), FIXTURE);
    expect(edit).not.toBeNull();
    const tags = new Set((edit as CodeEdit).hunks.map((h) => h.tag));
    expect(tags.has("gigaphone:trace:runCode")).toBe(true);
    // idempotent: a hunk whose tag already exists is dropped by the applier
    const once = applyEdits(FIXTURE, edit);
    const twice = applyEdits(once, pack.emitFix(run, primitive(FailureMode.UNTRACED, run), once));
    expect(once).toBe(twice);
    expect((edit as CodeEdit).hunks[0]).toHaveProperty("byteStart");
  });
});

function count(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}
