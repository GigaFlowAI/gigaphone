/**
 * Structural test — mechanically enforces the ARCHITECTURE.md §2 layering (harness-engineering:
 * "layered architecture with mechanical enforcement"). A violating import fails the build, so
 * the neutral-core invariant (ADR-0002) can't rot silently.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The repo-relative import specifiers a file references (static import/export-from). */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf-8");
  const specs: string[] = [];
  const re = /\b(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(text)) !== null) specs.push(m[1]!);
  return specs;
}

/** Which top-level src layer a file or a relative import resolves into. */
function layerOf(absPath: string): string {
  const rel = relative(SRC, absPath).replace(/\\/g, "/");
  const top = rel.split("/")[0]!;
  if (top === "cli.ts" || top === "index.ts") return "cli";
  return top; // core | interfaces | config | packs | adapters | engine
}

describe("architecture: layered dependency flow (ARCHITECTURE.md §2)", () => {
  const files = tsFiles(SRC);

  it("core/ imports nothing from higher layers", () => {
    const violations: string[] = [];
    for (const f of files) {
      if (layerOf(f) !== "core") continue;
      for (const spec of importsOf(f)) {
        if (!spec.startsWith(".")) continue;
        const target = layerOf(join(dirname(f), spec));
        if (["interfaces", "config", "packs", "adapters", "engine", "cli"].includes(target)) {
          violations.push(`${relative(SRC, f)} → ${spec} (${target})`);
        }
      }
    }
    expect(violations, `core must depend on nothing:\n${violations.join("\n")}`).toEqual([]);
  });

  it("engine/ imports adapters & packs only via their registries, never a concrete impl", () => {
    const violations: string[] = [];
    for (const f of files) {
      if (layerOf(f) !== "engine") continue;
      for (const spec of importsOf(f)) {
        if (!spec.startsWith(".")) continue;
        const norm = spec.replace(/\\/g, "/");
        const intoAdapterImpl = /\/adapters\/.+\//.test(norm) && !norm.endsWith("/registry.js");
        const intoPackImpl = /\/packs\/.+\//.test(norm) && !norm.endsWith("/registry.js");
        // allow the backend index/registry and pack registry; forbid deep concrete impls
        if (intoAdapterImpl || intoPackImpl) {
          violations.push(`${relative(SRC, f)} → ${spec}`);
        }
      }
    }
    expect(
      violations,
      `engine must reach axes via registries only:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("no layer imports cli", () => {
    const violations: string[] = [];
    for (const f of files) {
      if (layerOf(f) === "cli") continue;
      for (const spec of importsOf(f)) {
        if (spec.replace(/\\/g, "/").endsWith("/cli.js")) {
          violations.push(`${relative(SRC, f)} → ${spec}`);
        }
      }
    }
    expect(violations, `cli is the edge:\n${violations.join("\n")}`).toEqual([]);
  });
});
