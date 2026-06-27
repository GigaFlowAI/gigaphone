/**
 * `gigaphone review` — the bidirectional harness review (DESIGN §5; ADR-0004, ADR-0006).
 *
 * Deterministic discovery is high-precision but misses indirect shapes; the harness audits
 * the proposal — REJECT false positives, ADD missed boundaries — and the result is committed.
 * The model is in the loop only here, at authoring time; CI replays the committed config.
 */

import { BoundaryKind } from "../core/boundary.js";
import { Descriptor } from "../core/model.js";

export interface ReviewAdd {
  match_call: string;
  id?: string;
  kind?: string;
  input_arg?: string;
  output_paths?: string[];
  emit_name?: string;
}

export interface Review {
  reject?: string[];
  add?: ReviewAdd[];
}

export interface ReviewSummary {
  rejected: string[];
  added: string[];
  kept: number;
}

export function applyReview(
  descriptors: Descriptor[],
  review: Review,
): [Descriptor[], ReviewSummary] {
  const rejected = new Set(review.reject ?? []);
  const kept = descriptors.filter((d) => !rejected.has(d.id));
  const added: Descriptor[] = [];
  for (const a of review.add ?? []) {
    const call = a.match_call;
    added.push(
      new Descriptor({
        id: a.id || call,
        kind: (a.kind ?? BoundaryKind.AGENT_CALL) as BoundaryKind,
        matchCall: call,
        inputArg: a.input_arg ?? null,
        outputPaths: [...(a.output_paths ?? [])],
        emitName: a.emit_name ?? null,
      }),
    );
  }
  const byCall = new Map<string, Descriptor>();
  for (const d of kept) byCall.set(d.matchCall, d);
  for (const d of added) byCall.set(d.matchCall, d);
  const summary: ReviewSummary = {
    rejected: [...rejected].sort(),
    added: added.map((d) => d.matchCall),
    kept: kept.length,
  };
  return [[...byCall.values()], summary];
}
