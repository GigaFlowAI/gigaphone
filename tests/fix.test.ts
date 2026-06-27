/**
 * Idempotent multi-hunk applier (engine/fix.applyHunks) — mirrors Python engine.fix._apply_hunks.
 *
 * Contract: collect hunks from all edits against ONE snapshot, skip a hunk whose tag already
 * occurs in the file or was already seen, apply descending by byte offset into a UTF-8 buffer
 * so earlier offsets stay valid. Apply-once == apply-twice; byte-accurate (golden principle 7).
 */

import { describe, expect, it } from "vitest";
import type { CodeEdit, Hunk } from "../src/core/model.js";
import { applyHunks } from "../src/engine/fix.js";

function hunk(byteStart: number, byteEnd: number, newText: string, tag: string): Hunk {
  return { byteStart, byteEnd, newText, tag };
}

function edit(path: string, hunks: Hunk[], description = "fix"): CodeEdit {
  return { path, hunks, description };
}

describe("applyHunks", () => {
  it("is byte-accurate across a multibyte character", () => {
    const source = "héllo world\n"; // "héllo " is 7 bytes (é = 2)
    expect(Buffer.byteLength("héllo ", "utf-8")).toBe(7);
    const e = edit("f", [hunk(7, 7, "[gigaphone:foo]", "gigaphone:foo")]);
    const [after, skipped] = applyHunks(source, [e]);
    expect(after).toBe("héllo [gigaphone:foo]world\n");
    expect(skipped).toBe(0);
  });

  it("applies multiple hunks descending so earlier offsets stay valid", () => {
    const source = "héllo world\n";
    const e = edit("f", [
      hunk(0, 0, "import x // gigaphone:imp\n", "gigaphone:imp"),
      hunk(7, 7, "[gigaphone:foo]", "gigaphone:foo"),
    ]);
    const [after, skipped] = applyHunks(source, [e]);
    expect(after).toBe("import x // gigaphone:imp\nhéllo [gigaphone:foo]world\n");
    expect(skipped).toBe(0);
  });

  it("apply-once == apply-twice (idempotent: tag now present in the file)", () => {
    const source = "héllo world\n";
    const e = edit("f", [
      hunk(0, 0, "import x // gigaphone:imp\n", "gigaphone:imp"),
      hunk(7, 7, "[gigaphone:foo]", "gigaphone:foo"),
    ]);
    const [once] = applyHunks(source, [e]);
    // re-render the same logical edit against the already-fixed snapshot
    const [twice, skipped] = applyHunks(once, [e]);
    expect(twice).toBe(once);
    expect(skipped).toBe(2); // both tags already present → both skipped
  });

  it("skips a hunk whose tag already occurs in the source", () => {
    const source = "already has gigaphone:foo marker\n";
    const e = edit("f", [hunk(0, 0, "[gigaphone:foo]", "gigaphone:foo")]);
    const [after, skipped] = applyHunks(source, [e]);
    expect(after).toBe(source);
    expect(skipped).toBe(1);
  });

  it("de-dupes a tag seen twice across edits in one pass", () => {
    const source = "body\n";
    const e1 = edit("f", [hunk(0, 0, "A:gigaphone:dup\n", "gigaphone:dup")]);
    const e2 = edit("f", [hunk(0, 0, "B:gigaphone:dup\n", "gigaphone:dup")]);
    const [after, skipped] = applyHunks(source, [e1, e2]);
    // only the first hunk with that tag applied; the second is skipped
    expect(after).toBe("A:gigaphone:dup\nbody\n");
    expect(skipped).toBe(1);
  });

  it("a pure replacement uses byteEnd > byteStart", () => {
    const source = "abcdef";
    const e = edit("f", [hunk(2, 4, "XY:gigaphone:r", "gigaphone:r")]);
    const [after] = applyHunks(source, [e]);
    expect(after).toBe("abXY:gigaphone:ref");
  });
});
