/**
 * BackendAdapter interface — the *vendor* axis (DESIGN §9, ADR-0002).
 *
 * The entire vendor-specific surface: emit + verify. Two-tier — a generic OTel/OpenInference
 * adapter targets any OTLP backend (new platform = endpoint + headers, no code); native
 * adapters (Braintrust, LangSmith) extend it and override where native semantics win.
 * Adapters cluster into contextvars-native and OTel families and reuse most fix logic within
 * a family.
 *
 * Ships `otel` + `braintrust` + `langsmith` (contextvars-native family) + `logfire` +
 * `phoenix` (OTel-native family) under `adapters/backend/`.
 */

import type { FailureMode } from "../core/boundary.js";
import type { Boundary, Expectation, FixPrimitive, VerifyResult } from "../core/model.js";

export interface VerifyProject {
  repo: string;
  module?: string;
  root?: string;
  lang?: string;
  entry?: string;
}

export abstract class BackendAdapter {
  abstract readonly id: string; // "otel" | "braintrust" | "langsmith" | ...

  /** Is this backend's SDK/OTel usage already present in the repo? Drives selection. */
  abstract detectPresence(repo: string): boolean;

  /** Schema for this backend's configuration (endpoint/headers/keys/project). */
  abstract configSchema(): Record<string, string>;

  /** The one-time initialisation snippet to add to the customer's codebase. */
  abstract initSnippet(config: Record<string, string>): string;

  /** Map a boundary + failure mode to the vendor fix primitive, rendered per language. */
  abstract primitiveFor(boundary: Boundary, mode: FailureMode, lang?: string): FixPrimitive;

  /** What this boundary's span must look like post-fix (stateless; ADR-0005). */
  abstract expectationFor(boundary: Boundary): Expectation;

  /**
   * Confirm expected tool spans appear nested + complete in the customer's project, using the
   * same read path the eval platform uses. No coverage without this (ADR-0005).
   */
  abstract verify(project: VerifyProject, run: Expectation[]): VerifyResult[];
}
