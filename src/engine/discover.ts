/**
 * `gigaphone discover` — Phase A (DESIGN §8.2/§8.3).
 *
 * Deterministic heuristic discovery: run each language pack's `discover` over the scoped files
 * and union the proposed descriptors. The head-less fallback the e2e uses; the harness-driven
 * discovery protocol can supersede or confirm these before they are committed (ADR-0004/0006).
 */

import type { Descriptor } from "../core/model.js";
import type { CodebaseAdapter } from "../interfaces/codebaseAdapter.js";
import { packForPath } from "../packs/registry.js";
import { read, scan } from "./project.js";

/**
 * Phase A discovery. Unions each language pack's heuristic `discover` with any active
 * `CodebaseAdapter`s' bespoke recognition (DESIGN §8; ADR-0010). Codebase adapters win ties
 * (they encode authored knowledge of the codebase), so they are unioned first. Passing no
 * adapters preserves the original generic-discovery behavior exactly.
 */
export function discover(
  root: string,
  scope?: string,
  codebaseAdapters: CodebaseAdapter[] = [],
): Descriptor[] {
  const found = new Map<string, Descriptor>();
  const files = scan(root, scope);

  // A known harness can fully model its own boundaries; when any active adapter declares
  // itself authoritative, it *owns* discovery — only the authoritative adapters run, and the
  // generic packs (plus any non-authoritative adapters) are skipped so their name-matched
  // noise never reaches the config. See CodebaseAdapter.authoritative (ADR-0010).
  const authoritative = codebaseAdapters.filter((a) => a.authoritative(root));
  const adapters = authoritative.length ? authoritative : codebaseAdapters;

  // codebase adapters first — authored knowledge takes precedence over generic heuristics
  for (const adapter of adapters) {
    for (const sf of files) {
      for (const d of adapter.discover(sf.relPath, read(sf))) {
        if (!found.has(d.matchCall)) found.set(d.matchCall, d);
      }
    }
  }
  if (authoritative.length === 0) {
    for (const sf of files) {
      const pack = packForPath(sf.absPath);
      if (pack === null) continue;
      for (const d of pack.discover(sf.relPath, read(sf))) {
        if (!found.has(d.matchCall)) found.set(d.matchCall, d);
      }
    }
  }
  // stable order: gateways first, then tools, by id
  return [...found.values()].sort((a, b) =>
    a.kind !== b.kind ? a.kind.localeCompare(b.kind) : a.id.localeCompare(b.id),
  );
}
