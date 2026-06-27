/**
 * `gigaphone verify` — run a representative path and confirm tool spans land nested +
 * complete via the backend adapter's read path (DESIGN §12, ADR-0005).
 */

import type { Expectation, TreeVerifyResult, VerifyResult } from "../core/model.js";
import { TreeVerifyResult as TreeVerifyResultClass } from "../core/model.js";
import type { VerifyProject } from "../interfaces/backendAdapter.js";

/** A backend exposing both the per-span and the whole-tree read paths (OtelAdapter family). */
export interface VerifyBackend {
  verify(project: VerifyProject, run: Expectation[]): VerifyResult[];
  verifyTree(project: VerifyProject, run: Expectation[]): TreeVerifyResult;
}

export function verify(
  root: string,
  expectations: Expectation[],
  backend: VerifyBackend,
  module = "app.run_representative",
  lang = "python",
  entry: string | null = null,
): VerifyResult[] {
  if (!expectations.length) return [];
  const projectCtx: VerifyProject = {
    repo: root,
    root,
    module,
    lang,
    entry: entry ?? undefined,
  };
  return backend.verify(projectCtx, expectations);
}

/**
 * End-to-end: prove one representative run yields a single coherent trace tree with every LLM
 * + tool span nested + complete and each requested tool linked (this feature).
 */
export function verifyTree(
  root: string,
  expectations: Expectation[],
  backend: VerifyBackend,
  module = "app.run_representative",
  lang = "python",
  entry: string | null = null,
): TreeVerifyResult {
  if (!expectations.length) {
    return new TreeVerifyResultClass(false, null, [], [], "no expectations");
  }
  const projectCtx: VerifyProject = {
    repo: root,
    root,
    module,
    lang,
    entry: entry ?? undefined,
  };
  return backend.verifyTree(projectCtx, expectations);
}
