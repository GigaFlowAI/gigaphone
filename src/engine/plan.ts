/**
 * `gigaphone plan` — boundaries → plan records, plus the unresolved[] list (DESIGN §5, §11).
 *
 * A descriptor that resolved to no boundary is *unresolved* (the ambiguous ~20% the
 * deterministic pass can't localize) and is surfaced via the resolution protocol — never
 * silently skipped (golden principle 8).
 */

import { BoundaryKind } from "../core/boundary.js";
import type { Boundary, Descriptor } from "../core/model.js";
import { PlanRecord } from "../core/planRecord.js";

export interface Unresolved {
  descriptorId: string;
  matchCall: string;
  question: string;
}

export class Plan {
  constructor(
    readonly records: PlanRecord[],
    readonly unresolved: Unresolved[],
  ) {}

  get fixable(): PlanRecord[] {
    return this.records.filter((r) => r.failureModes.length > 0);
  }
}

export function buildPlan(descriptors: Descriptor[], boundaries: Boundary[]): Plan {
  const records = boundaries.map(
    (b) =>
      new PlanRecord({
        boundary: `${b.path}:${b.range.line}`,
        language: "python",
        providerOrFramework: b.providerOrFramework,
        kind: b.kind,
        toolsCovered: [...b.toolsCovered],
        failureModes: [...b.failureModes],
        completeOutputFields: [...b.completeOutputFields],
        source: b.source,
      }),
  );
  const resolvedCalls = new Set(boundaries.map((b) => b.call));
  const unresolved: Unresolved[] = descriptors
    .filter((d) => !resolvedCalls.has(d.matchCall))
    .map((d) => ({ descriptorId: d.id, matchCall: d.matchCall, question: questionFor(d) }));
  return new Plan(records, unresolved);
}

function questionFor(d: Descriptor): string {
  if (d.kind === BoundaryKind.AGENT_CALL) {
    return (
      `Could not localize \`${d.matchCall}\` (agent_call). Which function dispatches ` +
      "the sub-agent and returns its result? (The sub-agent itself is a black box — we " +
      "trace only this boundary.)"
    );
  }
  return (
    `Could not localize \`${d.matchCall}\` (${d.kind}). ` +
    "Which function consumes its result and returns it to the agent loop?"
  );
}
