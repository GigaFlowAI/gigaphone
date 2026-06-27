/**
 * Neutral core data model (DESIGN §4, §8.4, §11).
 *
 * The shared vocabulary between discovery, localization, the classifier, the language packs,
 * and the backend adapters. Names no harness, no vendor, and no codebase specifics beyond
 * what discovery wrote into a `Descriptor`. Field names are camelCase (TS taste invariant);
 * the YAML wire form (snake_case keys, `match.call`, `output.paths`) is preserved by the
 * Descriptor (de)serializers, and span/attribute keys stay verbatim wire strings.
 */

import type { BoundaryKind, FailureMode, Source } from "./boundary.js";

/** A byte-accurate source range (and 1-based line for human display). */
export class Range {
  constructor(
    readonly path: string,
    readonly byteStart: number,
    readonly byteEnd: number,
    readonly line: number,
  ) {}
}

/** YAML object shape for a descriptor (the committed `gigaphone.boundaries.yaml` schema). */
export interface DescriptorYaml {
  id: string;
  kind: string;
  match: { call: string };
  input?: { arg: string };
  output?: { path?: string; paths?: string[] };
  emit?: { name: string };
  provider?: string;
}

export interface DescriptorInit {
  id: string;
  kind: BoundaryKind;
  matchCall: string;
  inputArg?: string | null;
  outputPaths?: string[];
  emitName?: string | null;
  provider?: string | null;
}

/**
 * A boundary descriptor — the unit discovery proposes and the committed config stores
 * (DESIGN §8.4). The fourth axis (codebase shape) as *data* (ADR-0004).
 */
export class Descriptor {
  id: string;
  kind: BoundaryKind;
  matchCall: string;
  inputArg: string | null;
  outputPaths: string[];
  emitName: string | null;
  /**
   * for kind=llm: which provider the gateway uses — drives the fix path (Approach A).
   * "openai" | "anthropic" | "langchain" | "hand_rolled" | null (not an llm boundary).
   */
  provider: string | null;

  constructor(init: DescriptorInit) {
    this.id = init.id;
    this.kind = init.kind;
    this.matchCall = init.matchCall;
    this.inputArg = init.inputArg ?? null;
    this.outputPaths = init.outputPaths ?? [];
    this.emitName = init.emitName ?? null;
    this.provider = init.provider ?? null;
  }

  toYamlObj(): DescriptorYaml {
    const out: DescriptorYaml = { id: this.id, kind: this.kind, match: { call: this.matchCall } };
    if (this.inputArg) out.input = { arg: this.inputArg };
    if (this.outputPaths.length) {
      out.output =
        this.outputPaths.length !== 1
          ? { paths: [...this.outputPaths] }
          : { path: this.outputPaths[0] };
    }
    if (this.emitName) out.emit = { name: this.emitName };
    if (this.provider) out.provider = this.provider;
    return out;
  }

  static fromYamlObj(o: DescriptorYaml): Descriptor {
    const output = o.output ?? {};
    const paths = output.paths ?? (output.path !== undefined ? [output.path] : []);
    return new Descriptor({
      id: o.id,
      kind: o.kind as BoundaryKind,
      matchCall: o.match.call,
      inputArg: o.input?.arg ?? null,
      outputPaths: [...paths],
      emitName: o.emit?.name ?? null,
      provider: o.provider ?? null,
    });
  }
}

export interface BoundaryInit {
  descriptorId: string;
  kind: BoundaryKind;
  path: string;
  funcName: string;
  call: string;
  range: Range;
  failureModes?: FailureMode[];
  completeOutputFields?: string[];
  toolsCovered?: string[];
  providerOrFramework?: string;
  source?: Source;
  emitName?: string | null;
  existingSpanName?: string | null;
  provider?: string | null;
}

/**
 * A concrete consumption boundary located in source, with its detected failure modes
 * (DESIGN §3, §10). Produced by a language pack's `analyze`. Mutable: the pack fills in
 * placement hints and failure modes as it localizes.
 */
export class Boundary {
  descriptorId: string;
  kind: BoundaryKind;
  path: string;
  funcName: string;
  call: string;
  range: Range;
  failureModes: FailureMode[];
  completeOutputFields: string[];
  toolsCovered: string[];
  providerOrFramework: string;
  source: Source;
  // placement hints the emitter needs (byte offsets), all optional:
  decoratorInsertByte: number | null = null;
  spanBlockInsertByte: number | null = null;
  poolCtorRange: [number, number] | null = null;
  spanVar: string | null = null;
  completeValueExpr: string | null = null;
  existingSpanName: string | null;
  emitName: string | null;
  insertIndent: string | null = null;
  /**
   * the tool span must carry complete output attrs (true for untraced/lossy + their fixed
   * forms; false for off_context where nesting is the whole fix). Lets `verify` build a full
   * expectation from a boundary whether or not it still has a failure mode.
   */
  requiresCompleteAttrs = false;
  // --- LLM boundary (kind=llm) extras ---
  provider: string | null;
  requiresLlmConvention = false;
  llmMessagesArg: string | null = null;
  llmResponseExpr: string | null = null;
  llmModelExpr: string | null = null;
  llmModelAttr: string | null = null;

  constructor(init: BoundaryInit) {
    this.descriptorId = init.descriptorId;
    this.kind = init.kind;
    this.path = init.path;
    this.funcName = init.funcName;
    this.call = init.call;
    this.range = init.range;
    this.failureModes = init.failureModes ?? [];
    this.completeOutputFields = init.completeOutputFields ?? [];
    this.toolsCovered = init.toolsCovered ?? [];
    this.providerOrFramework = init.providerOrFramework ?? "unknown";
    this.source = init.source ?? "spec";
    this.emitName = init.emitName ?? null;
    this.existingSpanName = init.existingSpanName ?? null;
    this.provider = init.provider ?? null;
  }
}

/**
 * A vendor-specific fix rendered language-specifically (DESIGN §9, §11). The backend adapter
 * supplies the *pieces* (which import, which decorator/wrapper/setter); the language pack
 * decides *placement* and idempotency. One primitive per failure mode.
 */
export interface FixPrimitive {
  failureMode: FailureMode;
  backendId: string;
  importLine: string;
  emitName: string;
  outputFields?: string[];
  /** UNTRACED: decorator expression to put above the def */
  decorator?: string | null;
  /** OFF_CONTEXT: callable that re-parents pool workers */
  executorWrapper?: string | null;
  /** LOSSY_OUTPUT: "{span}.set_attribute(...)" template */
  attrSetterTemplate?: string | null;
}

/**
 * A single byte-range edit. `byteEnd === byteStart` means a pure insertion. `tag` is the
 * idempotency marker: if it already occurs in the file, the hunk is skipped.
 */
export interface Hunk {
  byteStart: number;
  byteEnd: number;
  newText: string;
  tag: string;
}

/** One logical, idempotent fix to one file — possibly several hunks (e.g. import + wrap). */
export interface CodeEdit {
  path: string;
  hunks: Hunk[];
  description: string;
}

/**
 * What a fixed tool boundary must look like in the backend after a representative run
 * (DESIGN §12). Backend-neutral: the shim records the same `gigaphone.output.*` keys
 * regardless of vendor.
 */
export interface Expectation {
  tool: string;
  spanName: string;
  requireNested: boolean;
  requireAttrs: string[];
  kind: string; // "tool_exec" | "llm"
}

export function expectation(
  tool: string,
  spanName: string,
  opts: { requireNested?: boolean; requireAttrs?: string[]; kind?: string } = {},
): Expectation {
  return {
    tool,
    spanName,
    requireNested: opts.requireNested ?? true,
    requireAttrs: opts.requireAttrs ?? [],
    kind: opts.kind ?? "tool_exec",
  };
}

/** Outcome of a single boundary's verification. */
export class VerifyResult {
  constructor(
    readonly tool: string,
    readonly found: boolean,
    readonly nested: boolean,
    readonly complete: boolean,
    readonly detail = "",
    readonly kind = "tool_exec",
  ) {}

  get ok(): boolean {
    return this.found && this.nested && this.complete;
  }

  get kindIsLlm(): boolean {
    return this.kind === "llm";
  }
}

/** Did the model's tool request causally link to a tool span in the same tree? */
export interface LinkageResult {
  requested: string;
  linked: boolean;
}

/**
 * End-to-end proof that one representative run produced a single coherent trace tree: a root
 * agent span with every LLM and tool span nested + complete, and each requested tool causally
 * linked to its span (DESIGN §12).
 */
export class TreeVerifyResult {
  constructor(
    readonly singleRoot: boolean,
    readonly rootSpanName: string | null,
    readonly results: VerifyResult[] = [],
    readonly linkage: LinkageResult[] = [],
    readonly detail = "",
  ) {}

  get ok(): boolean {
    return (
      this.singleRoot &&
      this.results.length > 0 &&
      this.results.every((r) => r.ok) &&
      this.linkage.every((l) => l.linked)
    );
  }
}
