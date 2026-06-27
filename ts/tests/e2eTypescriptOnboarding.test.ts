/**
 * End-to-end TypeScript onboarding: red → green → idempotent against a live Node run.
 *
 * Proves the whole wire path: discover the tool boundaries, classify them untraced, apply the
 * codemod (real `gigaphoneTrace` body-wrap + import), then run the representative path under
 * Node and read back the exported spans — confirming each tool span is now nested under the
 * agent root and complete, and that re-detecting finds nothing left to fix.
 *
 * Requires `node` (>= 23.6 for `.ts` type-stripping); skipped otherwise.
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectBackend } from "../src/adapters/backend/registry.js";
import * as config from "../src/config/config.js";
import { detect } from "../src/engine/detect.js";
import { discover } from "../src/engine/discover.js";
import { applyFixes } from "../src/engine/fix.js";
import type { VerifyProject } from "../src/interfaces/backendAdapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const TESTCLIENT = join(REPO, "testclient-ts");
const SHIM = join(HERE, "..", "assets", "runtime", "typescript", "gigaphone-core.mjs");

function nodeSupportsTs(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "gigaphone_probe_"));
  const f = join(dir, "probe.ts");
  writeFileSync(f, "const x: number = 1;\nconsole.log(x);\n");
  const p = spawnSync("node", [f], { encoding: "utf-8", timeout: 20_000 });
  return p.status === 0;
}

const maybe = nodeSupportsTs() ? it : it.skip;

function setupProject(): string {
  const dst = join(mkdtempSync(join(tmpdir(), "gigaphone_tsproj_")), "proj");
  cpSync(TESTCLIENT, dst, { recursive: true });
  const pkg = join(dst, "node_modules", "@gigaphone", "otel");
  mkdirSync(pkg, { recursive: true });
  cpSync(SHIM, join(pkg, "index.mjs"));
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@gigaphone/otel", version: "0.0.0", type: "module", main: "index.mjs" }),
  );
  return dst;
}

function projectCtx(root: string): VerifyProject {
  return { repo: root, root, lang: "typescript", entry: "app/run_representative.ts" };
}

describe("e2e: TypeScript onboarding (red → green → idempotent)", () => {
  maybe("traces untraced tools so they land nested + complete", () => {
    const root = setupProject();
    const backend = selectBackend(root, "otel");

    const descriptors = discover(root);
    config.save(root, descriptors);
    const boundaries = detect(root, descriptors);

    const tools = new Set(boundaries.filter((b) => b.kind === "tool_exec").map((b) => b.funcName));
    expect(tools.has("runCode")).toBe(true);
    expect(tools.has("webSearch")).toBe(true);

    const expectations = boundaries
      .filter((b) => b.kind === "tool_exec")
      .map((b) => backend.expectationFor(b));
    const ctx = projectCtx(root);

    // RED: before the fix the tools are untraced → their spans never reach the trace.
    const red = backend.verify(ctx, expectations);
    expect(red.length).toBeGreaterThan(0);
    expect(red.some((r) => !r.ok)).toBe(true);

    // GREEN: apply the codemod → tool spans land nested + complete under the agent.
    const result = applyFixes(root, boundaries, backend);
    expect(Object.keys(result.diffs).length).toBeGreaterThan(0);
    const green = backend.verify(ctx, expectations);
    expect(green.every((r) => r.ok)).toBe(true);

    // IDEMPOTENT: re-detecting the saved config finds nothing to fix; re-applying is a no-op.
    const boundaries2 = detect(root, config.load(root));
    expect(boundaries2.every((b) => b.failureModes.length === 0)).toBe(true);
    const again = applyFixes(root, boundaries2, backend);
    expect(Object.keys(again.diffs).length).toBe(0);
  });

  maybe("emits valid runnable code (import once + curried trace; app still runs)", () => {
    const root = setupProject();
    const backend = selectBackend(root, "otel");
    const descriptors = discover(root);
    const boundaries = detect(root, descriptors);
    applyFixes(root, boundaries, backend);

    const toolsSrc = readFileSync(join(root, "app", "tools.ts"), "utf-8");
    expect(toolsSrc).toContain('import { gigaphoneTrace } from "@gigaphone/otel";');
    expect(toolsSrc).toContain("gigaphoneTrace({");
    expect(toolsSrc).toContain("})(");
    expect((toolsSrc.match(/{/g) ?? []).length).toBe((toolsSrc.match(/}/g) ?? []).length);

    const proc = spawnSync("node", ["app/run_representative.ts"], {
      cwd: root,
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(proc.status, proc.stderr).toBe(0);
  });
});
