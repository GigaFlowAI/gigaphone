/**
 * Python language pack (ADR-0007) — TypeScript port over a python3 `ast`-dump bridge.
 *
 * Carries everything Python-specific: the anchor catalog, shallow same-file def-use, the
 * `off_context` signatures for Python's concurrency model, and the codemod emitters. The
 * engine talks only to the `LanguagePack` interface and never sees the AST (ADR-0002).
 *
 * Behavioral fidelity to `src/gigaphone/packs/python/pack.py` is the hard requirement: the
 * AST is the JSON serialization emitted by `astDump.py`, walked with the `ast.walk`-equivalent
 * generator, and every `isinstance(node, ast.X)` becomes `node.type === "X"`.
 */

import { BoundaryKind, FailureMode, Source } from "../../core/boundary.js";
import {
  Boundary,
  type CodeEdit,
  Descriptor,
  type FixPrimitive,
  type Hunk,
  Range,
} from "../../core/model.js";
import { SourceMap } from "../../core/sourceMap.js";
import { LanguagePack } from "../../interfaces/languagePack.js";
import * as agentSdks from "./agentSdks.js";
import type { AgentSdk } from "./agentSdks.js";
import { attrChain, type Node, multilineStringInteriorLines, parse, unparse, walk } from "./ast.js";

// --- built-in anchor catalog (DESIGN §7.1) -------------------------------------------
// Execution sinks: trace the wrapping function, never inside (DESIGN §3). Matched on the
// dotted call so `os.environ` / `os.path` are NOT mistaken for `os.system`.
const EXEC_CALL_PREFIXES = ["subprocess.", "os.exec", "e2b.", "modal.", "docker."];
const EXEC_CALL_EXACT = new Set(["os.system", "os.popen", "exec", "eval", "pyodide.runPython"]);
const GATEWAY_CLASS_HINTS = ["llm", "gateway", "client", "model"];
const GATEWAY_METHODS = new Set(["chat", "complete", "completion", "generate", "create", "invoke"]);
const SPAN_STARTERS = ["start_as_current_span", "start_span"];
const POOL_CTORS = new Set(["ThreadPoolExecutor", "ProcessPoolExecutor"]);
// context-hop signatures: a span created behind one of these orphans unless context is
// restored. `asyncio.create_task` copies context — intentionally absent.
const CONTEXT_HOP_CALLS = new Set(["submit", "map", "run_in_executor", "to_thread", "apply_async"]);
// provider SDK call signatures → provider tag. Ordered: more specific first (endswith match).
const SDK_CALL_PROVIDERS: [string, string][] = [
  ["chat.completions.create", "openai"],
  ["responses.create", "openai"],
  ["messages.create", "anthropic"],
  ["completions.create", "openai"],
];
// attr names that mark an llm span as already convention-complete (idempotency).
const LLM_FIX_FUNCS = ["gigaphone_llm_complete", "gigaphone_llm_trace"];

const INPUT_ARGS = ["messages", "prompt", "input"];

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

function sliceBytes(source: string, start: number, end?: number): string {
  return _decoder.decode(_encoder.encode(source).slice(start, end));
}

function endsWithAny(s: string, prefixes: string[]): boolean {
  return prefixes.some((p) => s.startsWith(p));
}

function tail(dotted: string): string {
  const parts = dotted.split(".");
  return parts[parts.length - 1] ?? "";
}

function provider_sdk_call(fn: Node): string | null {
  for (const n of walk(fn)) {
    if (n.type === "Call") {
      const dotted = attrChain(n.func);
      for (const [sig, prov] of SDK_CALL_PROVIDERS) {
        if (dotted.endsWith(sig)) return prov;
      }
    }
  }
  return null;
}

function is_truncation(node: Node | null | undefined): boolean {
  return !!node && node.type === "Subscript" && (node as Node).slice?.type === "Slice";
}

function truncation_base(node: Node): string | null {
  if (!is_truncation(node)) return null;
  let base: Node = node.value;
  if (base.type === "Call" && (base.args as Node[]).length) base = (base.args as Node[])[0];
  return attrChain(base) || null;
}

/** Collect FunctionDefs by name (top-level, nested, and methods); first def of a name wins.
 * Mirrors `_Functions` (a NodeVisitor): DFS pre-order, `setdefault` semantics. */
function collectFunctions(tree: Node): Map<string, Node> {
  const byName = new Map<string, Node>();
  const visit = (node: Node): void => {
    if (node.type === "FunctionDef" || node.type === "AsyncFunctionDef") {
      if (!byName.has(node.name)) byName.set(node.name, node);
    }
    for (const field of node._fields) {
      const value = node[field];
      if (value && typeof value === "object" && typeof (value as Node).type === "string") {
        visit(value as Node);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && typeof (item as Node).type === "string") {
            visit(item as Node);
          }
        }
      }
    }
  };
  visit(tree);
  return byName;
}

export class PythonPack extends LanguagePack {
  readonly id = "python";
  readonly extensions = [".py"] as const;

  // ----------------------------------------------------------------- discovery (Phase A)
  discover(path: string, source: string): Descriptor[] {
    const tree = parse(source);
    if (tree === null) return [];
    const module = module_name(path);
    const imports = import_map(tree);
    const out: Descriptor[] = [];

    // 1) hand-rolled LLM gateway.
    for (const cls of walk(tree)) {
      if (cls.type !== "ClassDef") continue;
      if (!GATEWAY_CLASS_HINTS.some((h) => (cls.name as string).toLowerCase().includes(h))) continue;
      for (const m of cls.body as Node[]) {
        if (m.type !== "FunctionDef") continue;
        if (GATEWAY_METHODS.has(m.name)) {
          const arg =
            ((m.args.args as Node[]).find((a) => INPUT_ARGS.includes(a.arg))?.arg as string) ?? null;
          out.push(
            new Descriptor({
              id: `${(cls.name as string).toLowerCase()}-gateway`,
              kind: BoundaryKind.LLM,
              matchCall: `${module}.${cls.name}.${m.name}`,
              inputArg: arg,
              emitName: `${proj(module)}.llm`,
              provider: provider_sdk_call(m) ?? "hand_rolled",
            }),
          );
          break;
        }
      }
    }

    // 1b) provider-SDK gateway.
    const sdkFuncs = collectFunctions(tree);
    for (const [name, fn] of sdkFuncs) {
      const provider = provider_sdk_call(fn);
      if (provider === null) continue;
      const call = `${module}.${name}`;
      if (out.some((d) => d.matchCall === call || d.matchCall.endsWith(`.${name}`))) continue;
      const arg =
        ((fn.args.args as Node[]).find((a) => INPUT_ARGS.includes(a.arg))?.arg as string) ?? null;
      out.push(
        new Descriptor({
          id: `${name}-gateway`,
          kind: BoundaryKind.LLM,
          matchCall: call,
          inputArg: arg,
          emitName: `${proj(module)}.llm`,
          provider,
        }),
      );
    }

    // 2) tool dispatch registry: a module-level dict {name: fn}.
    for (const assign of tree.body as Node[]) {
      if (assign.type !== "Assign") continue;
      if (!(assign.value.type === "Dict" && (assign.value.keys as Node[]).length)) continue;
      if (!(assign.value.keys as Node[]).every((k) => k.type === "Constant")) continue;
      const keys = assign.value.keys as Node[];
      const values = assign.value.values as Node[];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = values[i];
        const fn = attrChain(v);
        if (!fn || fn.includes(".")) continue;
        const target = imports[fn] ?? `${module}.${fn}`;
        out.push(
          new Descriptor({
            id: `tool-${k.value}`,
            kind: BoundaryKind.TOOL_EXEC,
            matchCall: target,
            inputArg: null,
            emitName: `${proj(module)}.${k.value}`,
          }),
        );
      }
    }

    // 3) fallback: a function in this file that wraps an execution sink.
    const funcs = collectFunctions(tree);
    for (const [name, fn] of funcs) {
      if (name.startsWith("_")) continue;
      if (wraps_exec_sink(fn) && !out.some((d) => d.matchCall.endsWith(`.${name}`))) {
        out.push(
          new Descriptor({
            id: `tool-${name}`,
            kind: BoundaryKind.TOOL_EXEC,
            matchCall: `${module}.${name}`,
            emitName: `${proj(module)}.${name}`,
          }),
        );
      }
    }

    // 4) agent-SDK dispatch (seed family B), provenance-gated.
    for (const [name, fn] of funcs) {
      if (name.startsWith("__")) continue;
      const sdk = match_direct(fn, imports) ?? match_construct_carrier(fn, imports, funcs);
      if (sdk !== null && !out.some((d) => d.matchCall.endsWith(`.${name}`))) {
        out.push(
          new Descriptor({
            id: `agent-${name}`,
            kind: BoundaryKind.AGENT_CALL,
            matchCall: `${module}.${name}`,
            inputArg: sdk.inputArg,
            outputPaths: [...sdk.outputFields],
            emitName: `${proj(module)}.subagent.${sdk.framework}`,
          }),
        );
      }
    }
    return dedupe(out);
  }

  // ------------------------------------------------------------- localization (Phase B)
  analyze(path: string, source: string, descriptors: Descriptor[]): Boundary[] {
    const tree = parse(source);
    if (tree === null) return [];
    const module = module_name(path);
    const smap = new SourceMap(source);
    const funcs = collectFunctions(tree);
    const boundaries: Boundary[] = [];

    for (const d of descriptors) {
      if (!targets_module(d.matchCall, module)) continue;
      const funcName = tail(d.matchCall);
      const fn = funcs.get(funcName);
      if (fn === undefined) continue;
      const b = this.analyzeFn(d, fn, module, path, source, smap, funcs, tree);
      if (b !== null) boundaries.push(b);
    }
    return boundaries;
  }

  private analyzeFn(
    d: Descriptor,
    fn: Node,
    module: string,
    path: string,
    source: string,
    smap: SourceMap,
    funcs: Map<string, Node>,
    tree: Node,
  ): Boundary | null {
    const rng = new Range(
      path,
      smap.offset(fn.lineno as number, fn.col_offset as number),
      smap.offset(fn.end_lineno as number, fn.end_col_offset as number),
      fn.lineno as number,
    );
    const b = new Boundary({
      descriptorId: d.id,
      kind: d.kind,
      path,
      funcName: fn.name,
      call: d.matchCall,
      range: rng,
      completeOutputFields: [...d.outputPaths],
      toolsCovered:
        d.kind === BoundaryKind.TOOL_EXEC || d.kind === BoundaryKind.AGENT_CALL
          ? [d.id.split(/-(.*)/s)[1] ?? d.id]
          : [],
      providerOrFramework: proj(module),
      source: Source.SPEC,
    });
    b.emitName = d.emitName;
    b.provider = d.provider;
    b.llmMessagesArg = d.inputArg;

    // complete output fields: infer from the return type if the descriptor didn't say.
    if (
      !b.completeOutputFields.length &&
      (d.kind === BoundaryKind.TOOL_EXEC || d.kind === BoundaryKind.AGENT_CALL)
    ) {
      b.completeOutputFields = infer_output_fields(fn, funcs);
    }

    // already fixed by a decorator (idempotent) -> covered.
    if (has_gigaphone_decorator(fn)) {
      b.existingSpanName = decorator_span_name(fn) ?? b.emitName;
      b.requiresCompleteAttrs = true;
      return b;
    }

    // LLM gateway: classify against the OpenInference convention.
    if (d.kind === BoundaryKind.LLM) {
      return this.classifyLlm(b, fn, smap);
    }

    const spanWith = find_span_with(fn);
    const hop = find_context_hop(fn);

    // off_context: work offloaded across a pool whose offloaded callee creates a span.
    if (hop !== null) {
      const [poolVar, callee] = hop;
      const calleeFn = funcs.get(callee);
      const calleeSpan = calleeFn !== undefined ? find_span_with(calleeFn) : null;
      if (calleeSpan !== null) {
        b.existingSpanName = span_name(calleeSpan);
        if (pool_already_wrapped(tree, poolVar)) return b; // context restored -> covered
        const ctor = find_pool_ctor(tree, poolVar, smap);
        b.failureModes = [FailureMode.OFF_CONTEXT];
        if (ctor !== null) b.poolCtorRange = ctor;
        return b;
      }
    }

    // traced at the boundary: is the recorded output a truncation of a complete value?
    if (spanWith !== null) {
      b.existingSpanName = span_name(spanWith);
      b.requiresCompleteAttrs = true;
      if (calls_function(fn, "gigaphone_complete")) return b; // already fixed in place
      const lossy = find_lossy_attr(spanWith);
      if (lossy !== null) {
        const [spanVar, completeExpr, insertLine, indent] = lossy;
        b.failureModes = [FailureMode.LOSSY_OUTPUT];
        b.spanVar = spanVar;
        b.completeValueExpr = completeExpr;
        b.spanBlockInsertByte = smap.lineStartOffset(insertLine);
        b.insertIndent = indent;
        if (!b.completeOutputFields.length) b.completeOutputFields = [completeExpr];
        return b;
      }
      return b; // traced + complete -> covered
    }

    // no span at the boundary -> untraced.
    b.failureModes = [FailureMode.UNTRACED];
    b.requiresCompleteAttrs = true;
    b.decoratorInsertByte = smap.lineStartOffset(
      (fn.decorator_list as Node[]).length
        ? ((fn.decorator_list as Node[])[0].lineno as number)
        : (fn.lineno as number),
    );
    b.insertIndent = " ".repeat(fn.col_offset as number);
    return b;
  }

  private classifyLlm(b: Boundary, fn: Node, smap: SourceMap): Boundary {
    b.requiresLlmConvention = true;
    // already convention-complete (idempotent) -> covered.
    if (LLM_FIX_FUNCS.some((name) => calls_function(fn, name))) {
      const spanWith = find_span_with(fn);
      b.existingSpanName = spanWith ? span_name(spanWith) : b.emitName;
      return b;
    }

    const spanWith = find_span_with(fn);
    if (spanWith !== null) {
      // a span exists but does not record the convention -> lossy_output: augment it.
      b.existingSpanName = span_name(spanWith);
      b.spanVar = with_span_var(spanWith);
      const ret = find_return(spanWith);
      if (ret !== null && ret.value !== null && ret.value !== undefined) {
        b.llmResponseExpr = unparse(ret.value);
        b.spanBlockInsertByte = smap.lineStartOffset(ret.lineno as number);
        b.insertIndent = " ".repeat(ret.col_offset as number);
      } else {
        const last = (spanWith.body as Node[])[(spanWith.body as Node[]).length - 1];
        b.spanBlockInsertByte = smap.lineStartOffset((last.end_lineno as number) + 1);
        b.insertIndent = " ".repeat(last.col_offset as number);
      }
      b.llmModelExpr = llm_model_expr(spanWith);
      if (b.spanVar !== null) b.failureModes = [FailureMode.LOSSY_OUTPUT];
      return b;
    }

    // no span at the gateway -> untraced: wrap it with a gigaphone llm span.
    b.failureModes = [FailureMode.UNTRACED];
    b.llmModelAttr = llm_model_attr(fn);
    b.decoratorInsertByte = smap.lineStartOffset(
      (fn.decorator_list as Node[]).length
        ? ((fn.decorator_list as Node[])[0].lineno as number)
        : (fn.lineno as number),
    );
    b.insertIndent = " ".repeat(fn.col_offset as number);
    return b;
  }

  // --------------------------------------------------------------------- fix emission
  emitFix(boundary: Boundary, primitive: FixPrimitive, source: string): CodeEdit | null {
    if (
      primitive.failureMode === FailureMode.UNTRACED &&
      boundary.kind === BoundaryKind.AGENT_CALL
    ) {
      const spanName =
        boundary.emitName ?? `${boundary.providerOrFramework}.${boundary.funcName}`;
      const edit = native_otel_body_wrap(source, boundary.funcName, spanName, "agent");
      if (edit !== null) edit.path = boundary.path;
      return edit;
    }

    const smap = new SourceMap(source);
    const importByte = import_insert_offset(source, smap);
    const importHunk: Hunk = {
      byteStart: importByte,
      byteEnd: importByte,
      newText: `${primitive.importLine}\n`,
      tag: primitive.importLine,
    };

    // LLM lossy_output: augment the existing gateway span with the OpenInference convention.
    if (
      boundary.kind === BoundaryKind.LLM &&
      primitive.failureMode === FailureMode.LOSSY_OUTPUT &&
      boundary.spanBlockInsertByte !== null &&
      boundary.spanVar !== null
    ) {
      const at = boundary.spanBlockInsertByte;
      const indent = boundary.insertIndent ?? indent_at(source, at);
      const arg = boundary.llmMessagesArg ?? "messages";
      const resp = boundary.llmResponseExpr ?? "None";
      const model = boundary.llmModelExpr ?? "None";
      const tag = `gigaphone:llm:${boundary.funcName}`;
      const call =
        `gigaphone_llm_complete(${boundary.spanVar}, ` +
        `messages=${arg}, response=${resp}, model=${model})`;
      return {
        path: boundary.path,
        hunks: [importHunk, { byteStart: at, byteEnd: at, newText: `${indent}${call}  # ${tag}\n`, tag }],
        description:
          `record the OpenInference LLM convention for \`${boundary.funcName}\` ` +
          `(${primitive.backendId})`,
      };
    }

    if (primitive.failureMode === FailureMode.UNTRACED && boundary.decoratorInsertByte !== null) {
      const at = boundary.decoratorInsertByte;
      const indent = boundary.insertIndent ?? indent_at(source, at);
      const tag = `gigaphone:trace:${boundary.funcName}`;
      const deco = `${indent}@${primitive.decorator}  # ${tag}\n`;
      return {
        path: boundary.path,
        hunks: [importHunk, { byteStart: at, byteEnd: at, newText: deco, tag }],
        description: `trace untraced boundary \`${boundary.funcName}\` (${primitive.backendId})`,
      };
    }

    if (primitive.failureMode === FailureMode.OFF_CONTEXT && boundary.poolCtorRange) {
      const [start, end] = boundary.poolCtorRange;
      const orig = sliceBytes(source, start, end);
      const tag = `gigaphone:ctx:${boundary.funcName}`;
      const newText = `${primitive.executorWrapper}(${orig})  # ${tag}`;
      return {
        path: boundary.path,
        hunks: [importHunk, { byteStart: start, byteEnd: end, newText, tag }],
        description:
          `restore context across the pool for \`${boundary.funcName}\` (${primitive.backendId})`,
      };
    }

    if (
      primitive.failureMode === FailureMode.LOSSY_OUTPUT &&
      boundary.spanBlockInsertByte !== null
    ) {
      const at = boundary.spanBlockInsertByte;
      const indent = boundary.insertIndent ?? indent_at(source, at);
      const fields = (primitive.outputFields && primitive.outputFields.length
        ? primitive.outputFields
        : boundary.completeOutputFields) as string[];
      const tag = `gigaphone:complete:${boundary.funcName}`;
      const line = formatTemplate(primitive.attrSetterTemplate ?? "", {
        span: boundary.spanVar ?? "",
        value: boundary.completeValueExpr ?? "",
        fields: pyReprList(fields),
      });
      return {
        path: boundary.path,
        hunks: [importHunk, { byteStart: at, byteEnd: at, newText: `${indent}${line}  # ${tag}\n`, tag }],
        description: `record complete output for \`${boundary.funcName}\` (${primitive.backendId})`,
      };
    }
    return null;
  }
}

// --- module-level helpers (kept private to the pack) ----------------------------------

function basename(seg: string): string {
  // path segments here never contain "/" (already split), so basename(seg) === seg.
  return seg;
}

function module_name(path: string): string {
  let parts = path.replace(/\\/g, "/").split("/");
  parts[parts.length - 1] = parts[parts.length - 1].endsWith(".py")
    ? parts[parts.length - 1].slice(0, -3)
    : parts[parts.length - 1];
  // drop leading dirs up to and including a source root (empty segments from a leading "/").
  while (parts.length && !basename(parts[0])) parts.shift();
  // heuristic: start the module at the first "app"-like package segment if present.
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "app" || parts[i] === "src") {
      parts = parts.slice(i);
      break;
    }
  }
  if (parts.length && parts[0] === "src") parts = parts.slice(1);
  return parts.filter((p) => p && p !== "__init__").join(".");
}

function proj(module: string): string {
  return module.split(".")[0] || "app";
}

function import_map(tree: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of walk(tree)) {
    if (n.type === "ImportFrom" && n.module) {
      for (const a of n.names as Node[]) {
        out[(a.asname as string) || (a.name as string)] = `${n.module}.${a.name}`;
      }
    } else if (n.type === "Import") {
      for (const a of n.names as Node[]) {
        out[(a.asname as string) || (a.name as string)] = a.name as string;
      }
    }
  }
  return out;
}

function targets_module(matchCall: string, module: string): boolean {
  return matchCall === module || matchCall.startsWith(`${module}.`);
}

function has_gigaphone_decorator(fn: Node): boolean {
  return (fn.decorator_list as Node[]).some((dec) => attrChain(dec).includes("gigaphone_trace"));
}

function calls_function(fn: Node, name: string): boolean {
  for (const n of walk(fn)) {
    if (n.type === "Call" && tail(attrChain(n.func)) === name) return true;
  }
  return false;
}

function decorator_span_name(fn: Node): string | null {
  for (const dec of fn.decorator_list as Node[]) {
    if (dec.type === "Call" && attrChain(dec.func).includes("gigaphone_trace")) {
      for (const kw of dec.keywords as Node[]) {
        if (kw.arg === "name" && kw.value.type === "Constant") return kw.value.value;
      }
      const args = dec.args as Node[];
      if (args.length && args[0].type === "Constant") return args[0].value;
    }
  }
  return null;
}

function wraps_exec_sink(fn: Node): boolean {
  for (const n of walk(fn)) {
    if (n.type === "Call") {
      const dotted = attrChain(n.func);
      if (EXEC_CALL_EXACT.has(dotted) || endsWithAny(dotted, EXEC_CALL_PREFIXES)) return true;
    }
  }
  return false;
}

function origin(
  expr: Node | null | undefined,
  binds: Record<string, string>,
  imports: Record<string, string>,
): string | null {
  if (!expr || typeof expr.type !== "string") return null;
  if (expr.type === "Name") return binds[expr.id] ?? imports[expr.id] ?? null;
  if (expr.type === "Call") return origin(expr.func, binds, imports);
  if (expr.type === "Attribute") {
    const base = origin(expr.value, binds, imports);
    return base ? `${base}.${expr.attr}` : null;
  }
  return null;
}

function root_pkg(o: string | null): string | null {
  return o ? o.split(".")[0] : null;
}

function local_binds(fn: Node, imports: Record<string, string>): Record<string, string> {
  const binds: Record<string, string> = {};
  for (const n of walk(fn)) {
    if (
      n.type === "Assign" &&
      (n.value.type === "Call" || n.value.type === "Name" || n.value.type === "Attribute")
    ) {
      const o = origin(n.value, binds, imports);
      if (o) {
        for (const t of n.targets as Node[]) {
          if (t.type === "Name") binds[t.id] = o;
        }
      }
    }
  }
  return binds;
}

function match_direct(fn: Node, imports: Record<string, string>): AgentSdk | null {
  const binds = local_binds(fn, imports);
  for (const n of walk(fn)) {
    if (n.type === "Call" && n.func.type === "Attribute") {
      const pkg = root_pkg(origin(n.func.value, binds, imports));
      const sdk = agentSdks.matchPackageMethod(pkg, n.func.attr);
      if (sdk !== null) return sdk;
    }
  }
  return null;
}

const CARRIER_METHODS = agentSdks.carrierMethods();

function has_carrier(fn: Node): boolean {
  for (const n of walk(fn)) {
    if (n.type === "Call" && n.func.type === "Attribute" && CARRIER_METHODS.has(n.func.attr)) {
      return true;
    }
  }
  return false;
}

const HELPER_HOP_LIMIT = 5;

function local_helper_bodies(fn: Node, funcs: Map<string, Node>, limit = HELPER_HOP_LIMIT): Node[] {
  const bodies = [fn];
  const seen = new Set<Node>([fn]);
  const frontier: [Node, number][] = [[fn, 0]];
  while (frontier.length) {
    const [current, depth] = frontier.shift() as [Node, number];
    if (depth >= limit) continue;
    for (const n of walk(current)) {
      if (n.type === "Call") {
        const t = tail(attrChain(n.func));
        const helper = funcs.get(t);
        if (helper !== undefined && !seen.has(helper)) {
          seen.add(helper);
          bodies.push(helper);
          frontier.push([helper, depth + 1]);
        }
      }
    }
  }
  return bodies;
}

function annotation_symbols(ann: Node | null | undefined): string[] {
  const out: string[] = [];
  if (!ann || typeof ann.type !== "string") return out;
  if (ann.type === "Name") {
    out.push(ann.id);
  } else if (ann.type === "Attribute") {
    out.push(ann.attr);
  } else if (ann.type === "Constant" && typeof ann.value === "string") {
    out.push(tail(ann.value)); // string forward-ref
  } else if (ann.type === "Subscript") {
    out.push(...annotation_symbols(ann.value));
    out.push(...annotation_symbols(ann.slice));
  } else if (ann.type === "BinOp") {
    out.push(...annotation_symbols(ann.left));
    out.push(...annotation_symbols(ann.right));
  } else if (ann.type === "Tuple") {
    for (const e of ann.elts as Node[]) out.push(...annotation_symbols(e));
  }
  return out;
}

function match_construct_carrier(
  fn: Node,
  imports: Record<string, string>,
  funcs: Map<string, Node>,
): AgentSdk | null {
  if (!has_carrier(fn)) return null;
  for (const body of local_helper_bodies(fn, funcs)) {
    const binds = local_binds(body, imports);
    // (a) literal construct call nodes
    for (const n of walk(body)) {
      if (n.type === "Call") {
        const symbol = tail(attrChain(n.func));
        const pkg = root_pkg(origin(n.func, binds, imports));
        const sdk = agentSdks.matchConstruct(symbol, pkg);
        if (sdk !== null) return sdk;
      }
    }
    // (b) return-type annotation of a helper in the chain
    for (const symbol of annotation_symbols(body.returns)) {
      const sdk = agentSdks.matchConstruct(symbol, root_pkg(imports[symbol] ?? null));
      if (sdk !== null) return sdk;
    }
  }
  return null;
}

function with_span_var(spanWith: Node): string | null {
  for (const item of spanWith.items as Node[]) {
    if (item.optional_vars && item.optional_vars.type === "Name") return item.optional_vars.id;
  }
  return null;
}

function find_return(node: Node): Node | null {
  for (const n of walk(node)) {
    if (n.type === "Return") return n;
  }
  return null;
}

function llm_model_expr(spanWith: Node): string | null {
  for (const n of walk(spanWith)) {
    if (
      n.type === "Call" &&
      n.func.type === "Attribute" &&
      n.func.attr === "set_attribute" &&
      (n.args as Node[]).length >= 2
    ) {
      const key = (n.args as Node[])[0];
      if (key.type === "Constant" && typeof key.value === "string" && key.value.toLowerCase().includes("model")) {
        return unparse((n.args as Node[])[1]);
      }
    }
  }
  return null;
}

function llm_model_attr(fn: Node): string | null {
  for (const n of walk(fn)) {
    if (
      n.type === "Attribute" &&
      n.value.type === "Name" &&
      n.value.id === "self" &&
      ["model", "model_name", "_model"].includes(n.attr)
    ) {
      return n.attr;
    }
  }
  return null;
}

function find_span_with(fn: Node): Node | null {
  for (const n of walk(fn)) {
    if (n.type === "With") {
      for (const item of n.items as Node[]) {
        if (
          item.context_expr.type === "Call" &&
          SPAN_STARTERS.some((s) => attrChain(item.context_expr.func).includes(s))
        ) {
          return n;
        }
      }
    }
  }
  return null;
}

function span_name(spanWith: Node): string | null {
  for (const item of spanWith.items as Node[]) {
    if (item.context_expr.type === "Call" && (item.context_expr.args as Node[]).length) {
      const arg = (item.context_expr.args as Node[])[0];
      if (arg.type === "Constant" && typeof arg.value === "string") return arg.value;
    }
  }
  return null;
}

function find_context_hop(fn: Node): [string, string] | null {
  for (const n of walk(fn)) {
    if (
      n.type === "Call" &&
      n.func.type === "Attribute" &&
      CONTEXT_HOP_CALLS.has(n.func.attr) &&
      (n.args as Node[]).length
    ) {
      const poolVar = attrChain(n.func.value);
      const callee = attrChain((n.args as Node[])[0]);
      if (poolVar && callee) return [poolVar, callee];
    }
  }
  return null;
}

function assigns(node: Node, varName: string): boolean {
  return (
    node.type === "Assign" &&
    (node.targets as Node[]).some((t) => t.type === "Name" && t.id === varName)
  );
}

function find_pool_ctor(tree: Node, poolVar: string, smap: SourceMap): [number, number] | null {
  for (const n of walk(tree)) {
    if (!assigns(n, poolVar)) continue;
    const v = n.value;
    if (v.type === "Call" && POOL_CTORS.has(tail(attrChain(v.func)))) {
      return [
        smap.offset(v.lineno as number, v.col_offset as number),
        smap.offset(v.end_lineno as number, v.end_col_offset as number),
      ];
    }
  }
  return null;
}

function pool_already_wrapped(tree: Node, poolVar: string): boolean {
  for (const n of walk(tree)) {
    if (assigns(n, poolVar) && n.value.type === "Call" && attrChain(n.value.func).includes("propagate")) {
      return true;
    }
  }
  return false;
}

function find_lossy_attr(spanWith: Node): [string, string, number, string] | null {
  let spanVar: string | null = null;
  for (const item of spanWith.items as Node[]) {
    if (item.optional_vars && item.optional_vars.type === "Name") spanVar = item.optional_vars.id;
  }
  if (spanVar === null) return null;
  const body = spanWith.body as Node[];
  const lastStmt = body[body.length - 1];
  const indent = " ".repeat(lastStmt.col_offset as number);
  for (const n of walk(spanWith)) {
    if (
      n.type === "Call" &&
      n.func.type === "Attribute" &&
      n.func.attr === "set_attribute" &&
      (n.args as Node[]).length >= 2
    ) {
      const base = truncation_base((n.args as Node[])[1]);
      if (base) return [spanVar, base, (lastStmt.end_lineno as number) + 1, indent];
    }
  }
  return null;
}

function infer_output_fields(fn: Node, funcs: Map<string, Node>): string[] {
  let target = fn;
  const hop = find_context_hop(fn);
  if (hop !== null && funcs.has(hop[1])) {
    target = funcs.get(hop[1]) as Node;
  } else {
    for (const n of walk(fn)) {
      if (n.type === "Return" && n.value && n.value.type === "Call") {
        const callee = tail(attrChain(n.value.func));
        if (funcs.has(callee)) {
          target = funcs.get(callee) as Node;
          break;
        }
      }
    }
  }
  for (const n of walk(target)) {
    if (n.type === "Return" && n.value && n.value.type === "Call") {
      const kw = (n.value.keywords as Node[]).filter((k) => k.arg).map((k) => k.arg as string);
      if (kw.length) return kw;
    }
  }
  return [];
}

function import_insert_offset(source: string, smap: SourceMap): number {
  const tree = parse(source);
  let afterLine = 1;
  const body = (tree?.body as Node[]) ?? [];
  if (
    body.length &&
    body[0].type === "Expr" &&
    body[0].value.type === "Constant"
  ) {
    afterLine = (body[0].end_lineno as number) + 1;
  }
  for (const n of body) {
    if (n.type === "ImportFrom" && n.module === "__future__") afterLine = (n.end_lineno as number) + 1;
  }
  return smap.lineStartOffset(afterLine);
}

function indent_at(source: string, byteOffset: number): string {
  const text = sliceBytes(source, 0, byteOffset);
  const line = text.split("\n").pop() ?? "";
  return line.slice(0, line.length - line.replace(/^\s+/, "").length);
}

function dedupe(descriptors: Descriptor[]): Descriptor[] {
  const seen = new Map<string, Descriptor>();
  for (const d of descriptors) {
    if (!seen.has(d.matchCall)) seen.set(d.matchCall, d);
  }
  return [...seen.values()];
}

// --- python-repr / str.format helpers -------------------------------------------------

function pyReprStr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let body = s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  if (quote === "'") body = body.replace(/'/g, "\\'");
  else body = body.replace(/"/g, '\\"');
  return quote + body + quote;
}

function pyReprList(items: string[]): string {
  return `[${items.map((x) => pyReprStr(x)).join(", ")}]`;
}

function formatTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? `{${key}}`);
}

// --- native OTLP body-wrap codemod (Task NM1) ----------------------------------------

/** Split into lines keeping terminators — Python `splitlines(keepends=True)` (\n, \r\n, \r). */
function splitKeepEnds(source: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") {
      lines.push(source.slice(start, i + 1));
      start = i + 1;
    } else if (c === "\r") {
      if (source[i + 1] === "\n") {
        lines.push(source.slice(start, i + 2));
        i++;
      } else {
        lines.push(source.slice(start, i + 1));
      }
      start = i + 1;
    }
  }
  if (start < source.length) lines.push(source.slice(start));
  return lines;
}

export function native_otel_body_wrap(
  source: string,
  funcName: string,
  spanName: string,
  kind: string,
): CodeEdit | null {
  const tag = `gigaphone:trace:${funcName}`;
  if (source.includes(tag)) return null;

  const tree = parse(source);
  if (tree === null) return null;

  // locate the function by name (top-level, nested, or method)
  let fn: Node | null = null;
  for (const node of walk(tree)) {
    if ((node.type === "FunctionDef" || node.type === "AsyncFunctionDef") && node.name === funcName) {
      fn = node;
      break;
    }
  }
  if (fn === null || !(fn.body as Node[]).length) return null;

  const smap = new SourceMap(source);

  // Determine which statements to wrap (keep a leading docstring outside the block).
  let bodyStmts = fn.body as Node[];
  if (
    bodyStmts.length &&
    bodyStmts[0].type === "Expr" &&
    bodyStmts[0].value.type === "Constant" &&
    typeof bodyStmts[0].value.value === "string"
  ) {
    bodyStmts = bodyStmts.slice(1);
  }
  if (!bodyStmts.length) return null;

  const baseIndent = " ".repeat(bodyStmts[0].col_offset as number);

  const bodyStartByte = smap.lineStartOffset(bodyStmts[0].lineno as number);
  const bodyEndByte = smap.lineStartOffset((fn.end_lineno as number) + 1);

  const originalBodyText = sliceBytes(source, bodyStartByte, bodyEndByte);

  const noIndentLines = multilineStringInteriorLines(originalBodyText);

  const reindented: string[] = [];
  let lineNo = 0;
  for (const line of splitKeepEnds(originalBodyText)) {
    lineNo++;
    const stripped = line.replace(/[\r\n]+$/, "");
    if (stripped.trim() === "") {
      reindented.push("\n");
    } else if (noIndentLines.has(lineNo)) {
      reindented.push(line);
    } else {
      reindented.push(`    ${line}`);
    }
  }
  let reindentedBody = reindented.join("");
  if (!reindentedBody.endsWith("\n")) reindentedBody += "\n";

  const withHeader =
    `${baseIndent}with trace.get_tracer(__name__).start_as_current_span(` +
    `${pyReprStr(spanName)}) as span:  # ${tag}\n`;
  const setAttr = `${baseIndent}    span.set_attribute("gigaphone.kind", "${kind}")\n`;

  const newBodyText = withHeader + setAttr + reindentedBody;
  const bodyHunk: Hunk = { byteStart: bodyStartByte, byteEnd: bodyEndByte, newText: newBodyText, tag };

  const importLine = "from opentelemetry import trace";
  const importByte = import_insert_offset(source, smap);
  const importHunk: Hunk = {
    byteStart: importByte,
    byteEnd: importByte,
    newText: `${importLine}\n`,
    tag: importLine,
  };

  return {
    path: "<source>",
    hunks: [importHunk, bodyHunk],
    description: `native OTLP body-wrap for \`${funcName}\` (span=${pyReprStr(spanName)}, kind=${pyReprStr(kind)})`,
  };
}
