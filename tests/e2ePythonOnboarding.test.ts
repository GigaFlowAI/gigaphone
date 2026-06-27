/**
 * End-to-end Python onboarding against the bundled testclient (DESIGN §14).
 *
 * Proves the whole flow on a real agent app with a hand-rolled LLM gateway: discovery →
 * localization → (red) verify → fix → (green) verify → idempotent re-fix, plus the coherent
 * trace-tree check. The pre-fix verify failing is the breaking fixture (golden principle 5).
 *
 * Drives the target through `python3`; the representative run needs a python with
 * opentelemetry-sdk + the bundled shim. Probes the repo's `.venv` then `python3`, and skips
 * cleanly if neither can import opentelemetry (mirrors the node-version skip on the TS e2e).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { OtelAdapter } from "../src/adapters/backend/otel/adapter.js";
import * as config from "../src/config/config.js";
import { detect } from "../src/engine/detect.js";
import { discover } from "../src/engine/discover.js";
import { applyFixes } from "../src/engine/fix.js";
import { verify, verifyTree } from "../src/engine/verify.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const TESTCLIENT = join(REPO, "testclient", "app");

/** A python exe that can import opentelemetry, or null. */
function pythonWithOtel(): string | null {
  const candidates = [join(REPO, ".venv", "bin", "python"), "python3"];
  for (const py of candidates) {
    const p = spawnSync(py, ["-c", "import opentelemetry.sdk"], { encoding: "utf-8", timeout: 20_000 });
    if (p.status === 0) return py;
  }
  return null;
}

const PY = pythonWithOtel();
const maybe = PY ? it : it.skip;

beforeAll(() => {
  if (PY) process.env.GIGAPHONE_PYTHON = PY; // verify launches the target with this python
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "gigaphone_pyproj_"));
  cpSync(TESTCLIENT, join(root, "app"), { recursive: true });
  return root;
}

const backend = () => new OtelAdapter();
const expectationsOf = (b: ReturnType<typeof detect>, be: OtelAdapter) =>
  b.filter((x) => x.failureModes.length).map((x) => be.expectationFor(x));

describe("e2e: Python onboarding (testclient)", () => {
  it("toolchain available (python+opentelemetry)", () => {
    if (!PY) console.warn("skipping python e2e: no python with opentelemetry-sdk found");
    expect(true).toBe(true);
  });

  maybe("discovery finds the hand-rolled gateway and tools", () => {
    const descs = discover(repo(), "app");
    const byCall = new Map(descs.map((d) => [d.matchCall, d]));
    const gw = byCall.get("app.gateway.LLMGateway.chat");
    expect(gw?.kind).toBe("llm");
    const tools = new Set(descs.filter((d) => d.kind === "tool_exec").map((d) => d.matchCall));
    expect(tools.has("app.exec_tool.run_code")).toBe(true);
    expect(tools.has("app.web_tools.web_search")).toBe(true);
    expect(tools.has("app.web_tools.fetch_url")).toBe(true);
    expect(tools.has("app.tracing.init_tracing")).toBe(false);
  });

  maybe("localization classifies each failure mode", () => {
    const root = repo();
    const descs = discover(root, "app");
    const byName = new Map(detect(root, descs, "app").map((b) => [b.funcName, b]));
    expect(byName.get("run_code")?.failureModes).toEqual(["untraced"]);
    expect(byName.get("run_code")?.completeOutputFields).toEqual(["stdout", "stderr", "exit_code"]);
    expect(byName.get("fetch_url")?.failureModes).toEqual(["off_context"]);
    expect(byName.get("web_search")?.failureModes).toEqual(["lossy_output"]);
    expect(byName.get("chat")?.kind).toBe("llm");
    expect(byName.get("chat")?.failureModes).toEqual(["lossy_output"]);
  });

  maybe("full flow: red → green → idempotent", () => {
    const root = repo();
    const be = backend();
    const descs = discover(root, "app");
    config.save(root, descs);
    const boundaries = detect(root, descs, "app");
    const expectations = expectationsOf(boundaries, be);
    expect(expectations.length).toBe(4); // chat (llm) + run_code, web_search, fetch_url

    const before = verify(root, expectations, be);
    expect(before.every((v) => v.ok)).toBe(false);
    expect(new Set(before.filter((v) => !v.ok).map((v) => v.tool))).toEqual(
      new Set(["chat", "run_code", "web_search", "fetch_url"]),
    );

    const result = applyFixes(root, boundaries, be);
    expect(Object.keys(result.diffs).length).toBeGreaterThan(0);

    const after = verify(root, expectations, be);
    expect(after.every((v) => v.ok), JSON.stringify(after.map((v) => [v.tool, v.detail]))).toBe(true);

    const boundaries2 = detect(root, descs, "app");
    expect(
      boundaries2
        .filter((b) => ["chat", "run_code", "web_search", "fetch_url"].includes(b.funcName))
        .every((b) => b.failureModes.length === 0),
    ).toBe(true);
    const rerun = applyFixes(root, boundaries2, be);
    expect(Object.keys(rerun.diffs).length).toBe(0);
  });

  maybe("coherent trace tree after fix (single root, llm convention, tool linkage)", () => {
    const root = repo();
    const be = backend();
    const descs = discover(root, "app");
    config.save(root, descs);
    const boundaries = detect(root, descs, "app");
    const expectations = expectationsOf(boundaries, be);

    expect(verifyTree(root, expectations, be).ok).toBe(false); // incoherent before fix

    applyFixes(root, boundaries, be);
    const tree = verifyTree(root, expectations, be);
    expect(tree.singleRoot).toBe(true);
    expect(tree.rootSpanName).toBe("agent");
    const llm = tree.results.filter((r) => r.kindIsLlm);
    expect(llm.length).toBeGreaterThan(0);
    expect(llm.every((r) => r.ok)).toBe(true);
    expect(new Set(tree.linkage.map((l) => l.requested))).toEqual(
      new Set(["run_code", "web_search", "fetch_url"]),
    );
    expect(tree.linkage.every((l) => l.linked)).toBe(true);
    expect(tree.ok).toBe(true);
  });
});
