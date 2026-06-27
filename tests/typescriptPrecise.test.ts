/**
 * Precise (TypeScript-compiler-API) backend tests for the TypeScript pack (ADR-0007).
 * Ported from tests/test_typescript_treesitter.py — the tree-sitter backend is replaced by
 * the TS-compiler-API `precise` scanner.
 *
 * Guarantees: (1) the precise scanner finds free functions, class methods (carrying the
 * enclosing class name), and bare arrow consts; (2) it parses constructs the lexical scanner
 * cannot (bare arrow consts, generics carrying `{`/`>` in the header); (3) on source both
 * backends handle, their records are identical; and (4) the pack still works with the precise
 * backend forced off (the headless fallback).
 */

import { afterEach, describe, expect, it } from "vitest";
import { BoundaryKind, FailureMode } from "../src/core/boundary.js";
import {
  TypeScriptPack,
  scanFunctions,
  scanFunctionsLexical,
} from "../src/packs/typescript/pack.js";
import * as precise from "../src/packs/typescript/precise.js";

// A class method, a free function, and a *bare* arrow const (no type annotation).
const PARITY_SRC = `import { trace } from "@opentelemetry/api";

export class Gateway {
  async chat(messages: Message[]): Promise<Reply> {
    return this.plan(messages);
  }
}

export function runCode(code: string): Result {
  return execSync(code);
}

export const helper = (x: number) => {
  return x + 1;
};
`;

// Source both backends handle identically (typed arrow with a plain type, no `=>` in it).
const AGREE_SRC = `export function runCode(code: string): Result {
  return execSync(code);
}

export const helper: Helper = (x: number) => {
  return x + 1;
};
`;

type Tuple = [string, number, number, number, string | null, string];

function normRec(r: {
  name: string;
  headerChar: number;
  bodyOpen: number;
  bodyClose: number;
  className: string | null;
  indent: string;
}): Tuple {
  return [r.name, r.headerChar, r.bodyOpen, r.bodyClose, r.className, r.indent];
}

function sortTuples(ts: Tuple[]): Tuple[] {
  return [...ts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
}

const needsTs = precise.available();

afterEach(() => {
  precise.setBackendOverride(null);
});

describe("precise scanner (TS compiler API)", () => {
  it.runIf(needsTs)("finds function, method, and arrow", () => {
    const recs = new Map(precise.scan(PARITY_SRC).map((r) => [r.name, r]));
    expect(new Set(recs.keys())).toEqual(new Set(["chat", "runCode", "helper"]));
    expect(recs.get("chat")?.className).toBe("Gateway"); // method carries its enclosing class
    expect(recs.get("runCode")?.className).toBeNull();
    // the bare arrow const is exactly what the lexical scanner cannot see:
    expect(new Set(scanFunctionsLexical(PARITY_SRC).map((f) => f.name)).has("helper")).toBe(false);
  });

  it.runIf(needsTs)("dispatcher prefers precise when available", () => {
    // scanFunctions returns the full set incl. the arrow const -> the precise backend (not
    // lexical, which would drop `helper`) is the one in use.
    expect(new Set(scanFunctions(PARITY_SRC).map((f) => f.name))).toEqual(
      new Set(["chat", "runCode", "helper"]),
    );
  });

  it.runIf(needsTs)("backends agree byte-for-byte on source both handle", () => {
    const lexical = sortTuples(scanFunctionsLexical(AGREE_SRC).map(normRec));
    const tree = sortTuples(precise.scan(AGREE_SRC).map(normRec));
    expect(tree).toEqual(lexical);
  });

  it.runIf(needsTs)("precise parses generic header the lexical scanner misses", () => {
    // A generic type parameter with an object constraint sits between the name and the `(`,
    // which the lexical `function name(` regex cannot match — the compiler API parses it.
    const src =
      "export function runTool<T extends { id: number }>(code: string): T {\n" +
      "  return execSync(code);\n" +
      "}\n";
    expect(new Set(scanFunctionsLexical(src).map((f) => f.name)).has("runTool")).toBe(false);
    expect(new Set(precise.scan(src).map((r) => r.name)).has("runTool")).toBe(true);
  });

  it("pack falls back to lexical when precise backend forced off", () => {
    // Force the headless path: no precise backend → lexical scanner. Discovery + analysis of
    // the exec-sink tool must still work, proving the fallback is wired and equivalent.
    precise.setBackendOverride(false);
    const src =
      "export function runCode(code: string): Result {\n" +
      "  return execSync(code);\n" +
      "}\n" +
      "export const TOOLS: Record<string, Function> = { run_code: runCode };\n";
    const pack = new TypeScriptPack();
    const descs = pack.discover("app/agent.ts", src);
    const tool = descs.find((d) => d.matchCall === "app.agent.runCode");
    expect(tool).toBeDefined();
    expect(tool?.kind).toBe(BoundaryKind.TOOL_EXEC);
    const bs = new Map(pack.analyze("app/agent.ts", src, descs).map((b) => [b.funcName, b]));
    expect(bs.get("runCode")?.failureModes).toEqual([FailureMode.UNTRACED]);
  });
});
