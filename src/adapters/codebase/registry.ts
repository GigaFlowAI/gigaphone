/**
 * CodebaseAdapter registry + selection (DESIGN §4; ADR-0010).
 *
 * Two sources: bundled OSS adapters (shipped with the engine) and a repo-local proprietary
 * adapter loaded by convention from `gigaphone.codebase.{mjs,js}` at the repo root (a
 * customer's private adapter lives in their repo, not in this package). `detectAdapters`
 * returns the adapters whose `detect()` claims the repo — the set the engine unions into
 * Phase A discovery.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CodebaseAdapter } from "../../interfaces/codebaseAdapter.js";
import { OpenHandsAdapter } from "./examples/openhands.js";

const BUNDLED: CodebaseAdapter[] = [new OpenHandsAdapter()];

/** Convention filenames for a repo-local proprietary adapter (compiled, default-exported). */
const REPO_LOCAL = ["gigaphone.codebase.mjs", "gigaphone.codebase.js"];

export function bundledAdapters(): CodebaseAdapter[] {
  return [...BUNDLED];
}

export function adapterById(id: string): CodebaseAdapter | null {
  return BUNDLED.find((a) => a.id === id) ?? null;
}

/** Load a repo-local proprietary adapter (default export = a CodebaseAdapter subclass), or null. */
export async function loadRepoAdapter(repo: string): Promise<CodebaseAdapter | null> {
  for (const fn of REPO_LOCAL) {
    const p = join(repo, fn);
    if (!existsSync(p)) continue;
    const mod = (await import(pathToFileURL(p).href)) as { default?: new () => CodebaseAdapter };
    if (typeof mod.default === "function") return new mod.default();
  }
  return null;
}

/** All adapters (bundled + repo-local) whose `detect()` claims this repo. */
export async function detectAdapters(repo: string): Promise<CodebaseAdapter[]> {
  const all = [...BUNDLED];
  const local = await loadRepoAdapter(repo);
  if (local !== null) all.push(local);
  return all.filter((a) => a.detect(repo));
}
