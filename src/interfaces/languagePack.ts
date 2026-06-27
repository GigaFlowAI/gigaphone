/**
 * LanguagePack interface — the *language* axis (DESIGN §7, ADR-0002, ADR-0007).
 *
 * Parser-agnostic: the engine talks to this interface over the neutral core model
 * (`Boundary` / `CodeEdit`) and never sees a parser type. A pack carries everything
 * language-specific so the engine, classifier, specs, plan records, and both adapters stay
 * language-neutral. A new language is a new pack with no engine change.
 */

import type { Boundary, CodeEdit, Descriptor, FixPrimitive } from "../core/model.js";

export abstract class LanguagePack {
  abstract readonly id: string; // "python" | "typescript" | "rust" | ...
  abstract readonly extensions: readonly string[]; // (".py",) | (".ts", ".tsx") | ...

  /**
   * Localization (Phase B): run the built-in anchor catalog plus the confirmed config
   * descriptors over one source file, walk def-use, and return the boundaries found with
   * their detected failure modes. Byte-accurate.
   */
  abstract analyze(path: string, source: string, descriptors: Descriptor[]): Boundary[];

  /**
   * Deterministic heuristic discovery (Phase A fallback): propose codebase-specific boundary
   * descriptors (gateway, tool dispatch, execution sinks) for one source file.
   */
  abstract discover(path: string, source: string): Descriptor[];

  /**
   * Render a backend fix primitive into this language's syntax as a byte-accurate, idempotent
   * edit. Returns null if the boundary already carries the fix (upgrade in place / no
   * double-wrapping).
   */
  abstract emitFix(boundary: Boundary, primitive: FixPrimitive, source: string): CodeEdit | null;
}
