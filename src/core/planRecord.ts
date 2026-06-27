/**
 * Plan record — the axis-neutral unit the fix engine consumes (DESIGN §11).
 *
 * A plan record names no harness, no vendor, and no codebase specifics beyond what discovery
 * already wrote into config. It says only: *here is a boundary, here is what's wrong with its
 * span coverage, here is the complete output it should carry.* The codemod engine routes off
 * `failureModes` to backend-adapter primitives rendered by the active language pack.
 */

import type { BoundaryKind, FailureMode, Source } from "./boundary.js";

export interface PlanRecordInit {
  boundary: string; // "tools/exec.py:42" (path:line)
  language: string; // "python" | "typescript" | ...
  providerOrFramework: string; // "anthropic" | "langgraph" | "acme-gateway" | ...
  kind: BoundaryKind;
  toolsCovered?: string[];
  failureModes?: FailureMode[];
  completeOutputFields?: string[];
  source?: Source;
}

/** JSON wire shape (snake_case keys, enums as string values) — matches DESIGN §11. */
export interface PlanRecordDict {
  boundary: string;
  language: string;
  provider_or_framework: string;
  kind: string;
  tools_covered: string[];
  failure_modes: string[];
  complete_output_fields: string[];
  source: string;
}

export class PlanRecord {
  boundary: string;
  language: string;
  providerOrFramework: string;
  kind: BoundaryKind;
  toolsCovered: string[];
  failureModes: FailureMode[];
  completeOutputFields: string[];
  source: Source;

  constructor(init: PlanRecordInit) {
    this.boundary = init.boundary;
    this.language = init.language;
    this.providerOrFramework = init.providerOrFramework;
    this.kind = init.kind;
    this.toolsCovered = init.toolsCovered ?? [];
    this.failureModes = init.failureModes ?? [];
    this.completeOutputFields = init.completeOutputFields ?? [];
    this.source = init.source ?? "anchor";
  }

  toDict(): PlanRecordDict {
    return {
      boundary: this.boundary,
      language: this.language,
      provider_or_framework: this.providerOrFramework,
      kind: this.kind,
      tools_covered: [...this.toolsCovered],
      failure_modes: [...this.failureModes],
      complete_output_fields: [...this.completeOutputFields],
      source: this.source,
    };
  }

  static fromDict(d: PlanRecordDict): PlanRecord {
    return new PlanRecord({
      boundary: d.boundary,
      language: d.language,
      providerOrFramework: d.provider_or_framework,
      kind: d.kind as BoundaryKind,
      toolsCovered: [...(d.tools_covered ?? [])],
      failureModes: [...((d.failure_modes ?? []) as FailureMode[])],
      completeOutputFields: [...(d.complete_output_fields ?? [])],
      source: (d.source ?? "anchor") as Source,
    });
  }
}
