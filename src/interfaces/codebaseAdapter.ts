/**
 * CodebaseAdapter interface — the *codebase* axis as code (DESIGN §4; supersedes ADR-0004's
 * "config not code" for *known* codebases; see ADR-0010).
 *
 * The codebase axis was originally externalized as discovered data (`gigaphone.boundaries.yaml`).
 * For a *known* codebase or framework — an OSS product (OpenHands, LangGraph apps) or a
 * customer's proprietary harness (Arcanist) — a deterministic recognition adapter authored
 * *with knowledge of that codebase* is far more precise than generic discovery: it sees the
 * factory-built / registry / cross-module dispatch that dotted-call matching misses, and it
 * carries the codebase's intentional-redaction model so the auditor *preserves* deliberate
 * secret-scrubbing instead of "fixing" it.
 *
 * Like the other three axes this is deterministic code (no LLM in the loop — ADR-0006/0010);
 * its `discover()` output is the same neutral `Descriptor` model the language packs emit, and
 * it is materialized into the committed config at discover/review time, so deterministic
 * routine/CI passes still replay config (ADR-0004's real guarantee is preserved).
 *
 * The author fills in a scaffolded stub (`gigaphone codebase init <name>`): `detect` is the
 * only required method; the contributions below are optional and default to empty.
 */

import type { Boundary, Descriptor } from "../core/model.js";

/**
 * A field this codebase intentionally redacts and the reason — the class-D "preserve" set.
 * Any content-increasing fix that would expose one of these is suppressed; the auditor never
 * un-redacts a deliberately scrubbed secret/PII field.
 */
export interface RedactionRule {
  /** the output path / attribute that is deliberately scrubbed, e.g. "headers.authorization" */
  field: string;
  /** why it is redacted (credentials / PII / policy) — surfaced in the report */
  reason: string;
}

export abstract class CodebaseAdapter {
  abstract readonly id: string; // "arcanist" | "openhands" | ...

  /** Selection: is this repo that codebase/framework? (signature files, package markers). */
  abstract detect(repo: string): boolean;

  /**
   * Does this adapter *fully* model the codebase's trace-coverage boundaries on its own?
   *
   * A known harness exposes a finite, knowable set of consumption boundaries (e.g. hermes's
   * hook bus: one tool-dispatch seam + the LLM gateway). For such a codebase, generic
   * language-pack discovery only adds noise — it name-matches side-channel clients, exec-sink
   * utilities, and test helpers that are *not* the agent's consumption boundaries. When an
   * active adapter declares itself authoritative, Phase A discovery uses *only* the
   * authoritative adapters and skips the generic packs (and non-authoritative adapters),
   * trading generic recall for precision on a codebase the author understands completely.
   * Default false — an adapter only *augments* generic discovery (ADR-0010) unless it opts in.
   */
  authoritative(_repo: string): boolean {
    return false;
  }

  /** Optional scoping hints: dirs where the gateway / agent loop / tool dispatch live. */
  scope(): string[] {
    return [];
  }

  /**
   * Bespoke recognition → neutral Descriptors, augmenting language-pack discovery. Authored
   * with knowledge of the codebase, so it can resolve dispatch the generic matcher can't.
   */
  discover(_path: string, _source: string): Descriptor[] {
    return [];
  }

  /** Intentional redactions to PRESERVE (security; class D). */
  redactionModel(): RedactionRule[] {
    return [];
  }

  /** Where data crosses this codebase's process boundary (sandbox child→host; class-F reasoning). */
  processBoundaries(): Boundary[] {
    return [];
  }
}
