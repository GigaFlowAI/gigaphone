/**
 * `gigaphone fix` — route failure modes to backend primitives, render via the language
 * pack, apply byte-accurate idempotent edits, and emit reviewable diffs (DESIGN §11).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Boundary, CodeEdit, Expectation, Hunk } from "../core/model.js";
import type { BackendAdapter } from "../interfaces/backendAdapter.js";
import { packForPath } from "../packs/registry.js";
import * as project from "./project.js";

export class FixResult {
  edits: CodeEdit[] = [];
  expectations: Expectation[] = [];
  /** rel_path -> unified diff */
  diffs: Record<string, string> = {};
  skippedIdempotent = 0;
}

/** Compute the edits + expectations without writing (for diff preview). */
export function planFixes(
  root: string,
  boundaries: Boundary[],
  backend: BackendAdapter,
): FixResult {
  const result = new FixResult();
  // group edits per file so multiple boundaries in one file compose
  const perFile = new Map<string, CodeEdit[]>();
  for (const b of boundaries) {
    if (!b.failureModes.length) continue;
    const pack = packForPath(join(root, b.path));
    if (pack === null) continue;
    const source = project.read({ relPath: b.path, absPath: join(root, b.path) });
    for (const mode of b.failureModes) {
      const primitive = backend.primitiveFor(b, mode, pack.id);
      const edit = pack.emitFix(b, primitive, source);
      if (edit !== null) {
        if (!perFile.has(b.path)) perFile.set(b.path, []);
        perFile.get(b.path)!.push(edit);
      }
    }
    result.expectations.push(backend.expectationFor(b));
  }

  for (const edits of perFile.values()) result.edits.push(...edits);
  return result;
}

/** Apply fixes idempotently and produce unified diffs. */
export function applyFixes(
  root: string,
  boundaries: Boundary[],
  backend: BackendAdapter,
): FixResult {
  const result = planFixes(root, boundaries, backend);
  const perFile = new Map<string, CodeEdit[]>();
  for (const edit of result.edits) {
    if (!perFile.has(edit.path)) perFile.set(edit.path, []);
    perFile.get(edit.path)!.push(edit);
  }

  for (const [relPath, edits] of perFile) {
    const absPath = join(root, relPath);
    const before = readFileSync(absPath, "utf-8");
    const [after, skipped] = applyHunks(before, edits);
    result.skippedIdempotent += skipped;
    if (after !== before) {
      writeFileSync(absPath, after, "utf-8");
      result.diffs[relPath] = unifiedDiff(
        splitLinesKeepEnds(before),
        splitLinesKeepEnds(after),
        `a/${relPath}`,
        `b/${relPath}`,
      );
    }
  }
  return result;
}

/**
 * Apply all hunks for one file. Idempotent: a hunk whose tag already occurs in the file is
 * skipped (no double-wrapping). Hunks apply on byte offsets, descending, so earlier offsets
 * stay valid (golden principle 7).
 */
export function applyHunks(source: string, edits: CodeEdit[]): [string, number] {
  let data = Buffer.from(source, "utf-8");
  const hunks: Hunk[] = [];
  let skipped = 0;
  const seenTags = new Set<string>();
  for (const edit of edits) {
    for (const h of edit.hunks) {
      if (source.includes(h.tag) || seenTags.has(h.tag)) {
        skipped += 1;
        continue;
      }
      seenTags.add(h.tag);
      hunks.push(h);
    }
  }
  // de-dupe identical import hunks at the same offset
  for (const h of [...hunks].sort((a, b) => b.byteStart - a.byteStart)) {
    data = Buffer.concat([
      data.subarray(0, h.byteStart),
      Buffer.from(h.newText, "utf-8"),
      data.subarray(h.byteEnd),
    ]);
  }
  return [data.toString("utf-8"), skipped];
}

// --- unified diff (mirrors Python difflib.unified_diff for human-readable preview) ---------

function splitLinesKeepEnds(s: string): string[] {
  if (s === "") return [];
  const lines = s.split(/(?<=\n)/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Opcode = [string, number, number, number, number];

function getOpcodes(a: string[], b: string[]): Opcode[] {
  const m = a.length;
  const n = b.length;
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const raw: Opcode[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push(["equal", i, i + 1, j, j + 1]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      raw.push(["delete", i, i + 1, j, j]);
      i++;
    } else {
      raw.push(["insert", i, i, j, j + 1]);
      j++;
    }
  }
  while (i < m) {
    raw.push(["delete", i, i + 1, j, j]);
    i++;
  }
  while (j < n) {
    raw.push(["insert", i, i, j, j + 1]);
    j++;
  }
  // coalesce consecutive same-tag runs
  const merged: Opcode[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && last[0] === r[0]) {
      last[2] = r[2];
      last[4] = r[4];
    } else {
      merged.push([...r] as Opcode);
    }
  }
  // merge an adjacent delete+insert (in either order) into a replace
  const out: Opcode[] = [];
  for (let k = 0; k < merged.length; k++) {
    const cur = merged[k]!;
    const nxt = merged[k + 1];
    if (cur[0] === "delete" && nxt && nxt[0] === "insert") {
      out.push(["replace", cur[1], cur[2], nxt[3], nxt[4]]);
      k++;
    } else if (cur[0] === "insert" && nxt && nxt[0] === "delete") {
      out.push(["replace", cur[1], nxt[2], cur[3], cur[4]]);
      k++;
    } else {
      out.push(cur);
    }
  }
  return out;
}

function getGroupedOpcodes(codes: Opcode[], n = 3): Opcode[][] {
  let c = codes.map((x) => [...x] as Opcode);
  if (c.length === 0) c = [["equal", 0, 1, 0, 1]];
  const first = c[0]!;
  if (first[0] === "equal") {
    c[0] = [
      "equal",
      Math.max(first[1], first[2] - n),
      first[2],
      Math.max(first[3], first[4] - n),
      first[4],
    ];
  }
  const lastIdx = c.length - 1;
  const last = c[lastIdx]!;
  if (last[0] === "equal") {
    c[lastIdx] = [
      "equal",
      last[1],
      Math.min(last[2], last[1] + n),
      last[3],
      Math.min(last[4], last[3] + n),
    ];
  }
  const groups: Opcode[][] = [];
  let group: Opcode[] = [];
  for (const [tag, i1, i2, j1, j2] of c) {
    if (tag === "equal" && i2 - i1 > n * 2) {
      group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
      groups.push(group);
      group = [[tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2]];
      continue;
    }
    group.push([tag, i1, i2, j1, j2]);
  }
  if (group.length && !(group.length === 1 && group[0]![0] === "equal")) groups.push(group);
  return groups;
}

function formatRangeUnified(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

function unifiedDiff(a: string[], b: string[], fromFile: string, toFile: string, n = 3): string {
  const groups = getGroupedOpcodes(getOpcodes(a, b), n);
  if (groups.length === 0) return "";
  const out: string[] = [`--- ${fromFile}\n`, `+++ ${toFile}\n`];
  for (const group of groups) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const r1 = formatRangeUnified(first[1], last[2]);
    const r2 = formatRangeUnified(first[3], last[4]);
    out.push(`@@ -${r1} +${r2} @@\n`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(` ${line}`);
        continue;
      }
      if (tag === "replace" || tag === "delete") {
        for (const line of a.slice(i1, i2)) out.push(`-${line}`);
      }
      if (tag === "replace" || tag === "insert") {
        for (const line of b.slice(j1, j2)) out.push(`+${line}`);
      }
    }
  }
  return out.join("");
}
