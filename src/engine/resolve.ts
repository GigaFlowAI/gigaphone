/**
 * `gigaphone resolve` — ingest a harness-supplied resolution for unresolved boundaries
 * (DESIGN §5 resolution protocol). Schema-validated; an unresolvable item is reported, never
 * silently dropped (golden principle 8).
 */

import { BoundaryKind } from "../core/boundary.js";
import { Descriptor } from "../core/model.js";

export interface ResolutionItem {
  id?: string;
  unresolvable?: boolean;
  boundary_call?: string;
  kind?: string;
  complete_output_fields?: string[];
  emit_name?: string;
}

export interface Resolution {
  resolutions?: ResolutionItem[];
}

/** Return [new/updated descriptors, still-unresolvable ids]. */
export function ingestResolution(resolution: Resolution): [Descriptor[], string[]] {
  const descriptors: Descriptor[] = [];
  const unresolvable: string[] = [];
  for (const item of resolution.resolutions ?? []) {
    if (item.unresolvable) {
      unresolvable.push(item.id ?? "?");
      continue;
    }
    const call = item.boundary_call;
    if (!call) {
      unresolvable.push(item.id ?? "?");
      continue;
    }
    descriptors.push(
      new Descriptor({
        id: item.id ?? call,
        kind: (item.kind ?? BoundaryKind.TOOL_EXEC) as BoundaryKind,
        matchCall: call,
        outputPaths: [...(item.complete_output_fields ?? [])],
        emitName: item.emit_name ?? null,
      }),
    );
  }
  return [descriptors, unresolvable];
}
