/**
 * Rust language pack — v1 **lexical** implementation.
 *
 * Like the TypeScript pack, this is a pragmatic regex/brace-scanning parser, not a full CST.
 * It is deliberately parserless: tree-sitter-rust wheels are heavy and fragile to build in
 * headless CI, so v1 ships a lexical pack that covers the anchor catalog (gateway, tool
 * dispatch, execution sinks) and the failure-mode signatures for Rust's concurrency model —
 * `tokio::spawn` / `std::thread::spawn` / thread pools that drop the current `tracing` span
 * unless it is propagated. Per ADR-0007 a pack may choose its own parser; tree-sitter is the
 * planned upgrade for full byte-precise localization.
 *
 * It mirrors `PythonPack` / `TypeScriptPack`: `discover` proposes descriptors, `analyze`
 * classifies failure modes, `emitFix` renders idempotent, byte-accurate codemods. Lexical
 * limits: simple generic/parameter lists (no deeply nested `<...>` in the header), brace block
 * bodies, and no raw-string escapes — string and line/block comment scanning is byte-accurate,
 * and `'a` lifetimes are distinguished from `'x'` chars.
 */

import { BoundaryKind, FailureMode, Source } from "../../core/boundary.js";
import { Boundary, Descriptor, Range } from "../../core/model.js";
import type { CodeEdit, FixPrimitive, Hunk } from "../../core/model.js";
import { LanguagePack } from "../../interfaces/languagePack.js";

// --- built-in anchor catalog (DESIGN §7.1), Rust flavour -----------------------------
const GATEWAY_TYPE_HINTS = ["llm", "gateway", "client", "model"];
const GATEWAY_METHODS = new Set(["chat", "complete", "completion", "generate", "create", "invoke"]);
// span starters across the `tracing` crate / OTel / vendor SDKs in Rust
const SPAN_STARTERS = [
  "info_span!",
  "debug_span!",
  "trace_span!",
  "warn_span!",
  "error_span!",
  "span!",
  "start_span",
  "in_scope",
];
// execution sinks: trace the wrapping function, never inside (DESIGN §3)
const EXEC_SINKS = [
  "Command::new",
  "process::Command",
  ".output(",
  ".spawn(",
  ".status(",
  "Exec::",
];
// context-hop signatures for Rust's concurrency model (DESIGN §7.1, §10). Work handed to a
// spawned task / thread-pool worker starts its own span (an orphan root) unless the current
// span is propagated across the hop.
const HOP_SIGNATURES = [
  "tokio::spawn",
  "thread::spawn",
  "rayon::spawn",
  "spawn_blocking",
  ".spawn(",
  ".execute(",
  "pool.",
];
const POOL_CTOR_RE =
  /\b(?:[A-Za-z_]\w*::)*[A-Za-z_]*(?:ThreadPool|Pool|Runtime|Executor)\w*::new\s*\(/;
// a model-facing truncation: `&summary[..60]`, `summary[0..60]`, or `summary.chars().take(60)`
const SLICE_RE = /&?\s*([A-Za-z_]\w*)\s*\[\s*(?:\d+\s*)?\.\.=?\s*\d+\s*\]/;
const TAKE_RE = /\b([A-Za-z_]\w*)\s*\.\s*chars\s*\(\s*\)\s*\.\s*take\s*\(/;

const FN_RE = /\bfn\s+([A-Za-z_]\w*)/g;
const IMPL_RE = /\bimpl\b([^{;]*)\{/g;
const STRUCT_LIT_RE = /\b([A-Z][A-Za-z0-9_]*)\s*\{([^{}]*)\}/g;

interface Func {
  name: string;
  headerChar: number; // index of the line start of the function header
  bodyOpen: number; // index of the body `{`
  bodyClose: number; // index of the matching `}`
  typeName: string | null; // the `impl` type a method belongs to, else None
  indent: string;
}

function byteOf(source: string, charIdx: number): number {
  return new TextEncoder().encode(source.slice(0, charIdx)).length;
}

function lineStart(source: string, charIdx: number): number {
  const nl = source.lastIndexOf("\n", charIdx - 1);
  return nl + 1;
}

function indentOf(source: string, charIdx: number): string {
  const ls = lineStart(source, charIdx);
  const line = source.slice(ls, charIdx);
  return line.slice(0, line.length - line.replace(/^\s+/, "").length);
}

function skipString(source: string, i: number): number {
  /** Index just past a `"..."` string literal (honouring `\` escapes). */
  i += 1;
  const n = source.length;
  while (i < n) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === '"') {
      return i + 1;
    }
    i += 1;
  }
  return n;
}

function skipTick(source: string, i: number): number {
  /** `'` may open a char literal (`'x'`, `'\n'`) or a lifetime label (`'a`, `'static`).
   * Return the index just past a char literal, or just past the tick for a lifetime. */
  const n = source.length;
  if (i + 1 < n && source[i + 1] === "\\") {
    // char escape literal -> find closing tick
    let j = i + 2;
    while (j < n && source[j] !== "'") {
      j += 1;
    }
    return j < n ? j + 1 : n;
  }
  if (i + 2 < n && source[i + 2] === "'") {
    // single-char literal like 'x'
    return i + 3;
  }
  return i + 1; // lifetime label — consume only the tick, stay out of string mode
}

function matchBrace(source: string, openIdx: number, openCh: string, closeCh: string): number {
  /** Index of the matching close char, skipping strings, chars and comments. -1 if
   * unbalanced. */
  let depth = 0;
  let i = openIdx;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '"') {
      i = skipString(source, i);
      continue;
    }
    if (c === "'") {
      i = skipTick(source, i);
      continue;
    }
    if (c === "/" && i + 1 < n && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "/" && i + 1 < n && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === openCh) {
      depth += 1;
    } else if (c === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    i += 1;
  }
  return -1;
}

function isSpace(c: string | undefined): boolean {
  return c !== undefined && /\s/.test(c);
}

function paramsParen(source: string, afterName: number): number {
  /** Index of the parameter-list `(`, skipping a generic `<...>` after the fn name. */
  const n = source.length;
  let i = afterName;
  while (i < n && isSpace(source[i])) {
    i += 1;
  }
  if (i < n && source[i] === "<") {
    // balanced skip of the generic param list
    let depth = 0;
    while (i < n) {
      if (source[i] === "<") {
        depth += 1;
      } else if (source[i] === ">") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
    while (i < n && isSpace(source[i])) {
      i += 1;
    }
  }
  return i < n && source[i] === "(" ? i : -1;
}

function bodyAfter(source: string, parenOpen: number): [number, number] | null {
  /** Given the `(` of a param list, return (bodyOpenIdx, bodyCloseIdx). The return type /
   * `where` clause between `)` and the body `{` carry no braces in normal code. */
  const parenClose = matchBrace(source, parenOpen, "(", ")");
  if (parenClose === -1) {
    return null;
  }
  const brace = source.indexOf("{", parenClose);
  if (brace === -1) {
    return null;
  }
  const close = matchBrace(source, brace, "{", "}");
  if (close === -1) {
    return null;
  }
  return [brace, close];
}

function implType(headerIn: string): string | null {
  /** The Self type of an `impl` header: `impl Foo` -> Foo, `impl Trait for Foo` -> Foo. */
  let header = headerIn.replace(/<[^>]*>/g, " ");
  const padded = ` ${header} `;
  if (padded.includes(" for ")) {
    const idx = header.lastIndexOf(" for ");
    header = header.slice(idx + " for ".length);
  }
  const toks = [...header.matchAll(/[A-Za-z_]\w*/g)].map((m) => m[0]);
  return toks.length ? toks[toks.length - 1]! : null;
}

function scanFunctions(source: string): Func[] {
  const impls: Array<[number, number, string | null]> = [];
  for (const m of source.matchAll(IMPL_RE)) {
    const brace = m.index + m[0].length - 1;
    const close = matchBrace(source, brace, "{", "}");
    if (close !== -1) {
      impls.push([brace, close, implType(m[1]!)]);
    }
  }

  const enclosingType = (idx: number): string | null => {
    for (const [brace, close, tp] of impls) {
      if (brace < idx && idx < close) {
        return tp;
      }
    }
    return null;
  };

  const funcs: Func[] = [];
  for (const fm of source.matchAll(FN_RE)) {
    const name = fm[1]!;
    const fmEnd = fm.index + fm[0].length;
    const paren = paramsParen(source, fmEnd);
    if (paren === -1) {
      continue;
    }
    const body = bodyAfter(source, paren);
    if (body === null) {
      continue;
    }
    funcs.push({
      name,
      headerChar: lineStart(source, fm.index),
      bodyOpen: body[0],
      bodyClose: body[1],
      typeName: enclosingType(fm.index),
      indent: indentOf(source, fm.index),
    });
  }
  return funcs;
}

function moduleName(path: string): string {
  let parts = path.replace(/\\/g, "/").split("/");
  const last = parts[parts.length - 1]!;
  if (last.endsWith(".rs")) {
    parts[parts.length - 1] = last.slice(0, -3);
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "src" || p === "crate") {
      parts = parts.slice(i + 1);
      break;
    }
  }
  // main.rs / lib.rs / mod.rs are the crate/module root — drop them from the dotted name
  return parts.filter((p) => p && p !== "main" && p !== "lib" && p !== "mod").join(".");
}

function proj(module: string): string {
  return module.split(".")[0]! || "crate";
}

function importMap(source: string): Map<string, string> {
  /** Map an imported identifier -> dotted path (best-effort, lexical). */
  const out = new Map<string, string>();
  for (const m of source.matchAll(/\buse\s+([\w:]+)::\{([^}]*)\}\s*;/g)) {
    const base = m[1]!.replace(/::/g, ".");
    for (let name of m[2]!.split(",")) {
      name = name.trim().split(" as ").pop()!.trim();
      if (name) {
        out.set(name, `${base}.${name}`);
      }
    }
  }
  for (const m of source.matchAll(/\buse\s+([\w:]+)\s*;/g)) {
    const dotted = m[1]!.replace(/::/g, ".");
    const segs = dotted.split(".");
    out.set(segs[segs.length - 1]!, dotted);
  }
  return out;
}

export class RustPack extends LanguagePack {
  override readonly id = "rust";
  override readonly extensions = [".rs"] as const;

  // ------------------------------------------------------------- discovery (Phase A)
  override discover(path: string, source: string): Descriptor[] {
    const module = moduleName(path);
    const imports = importMap(source);
    const funcs = scanFunctions(source);
    const out: Descriptor[] = [];

    // 1) hand-rolled LLM gateway: a struct hinting gateway/llm/client with a chat-like
    //    method taking a messages/prompt/input arg. Invisible to provider anchors.
    const seenTypes = new Set<string>();
    for (const fn of funcs) {
      const tp = fn.typeName;
      if (tp === null || seenTypes.has(tp)) {
        continue;
      }
      if (!GATEWAY_TYPE_HINTS.some((h) => tp.toLowerCase().includes(h))) {
        continue;
      }
      if (GATEWAY_METHODS.has(fn.name)) {
        const header = source.slice(fn.headerChar, fn.bodyOpen);
        const arg = ["messages", "prompt", "input"].find((a) => header.includes(a)) ?? null;
        out.push(
          new Descriptor({
            id: `${tp.toLowerCase()}-gateway`,
            kind: BoundaryKind.LLM,
            matchCall: `${module}.${tp}.${fn.name}`,
            inputArg: arg,
            emitName: `${proj(module)}.llm`,
          }),
        );
        seenTypes.add(tp);
      }
    }

    // 2) tool dispatch: `match name { "tool" => tool_fn(..), .. }` (the idiomatic router).
    for (const [key, fnIdent] of registryEntries(source)) {
      const target = imports.get(fnIdent) ?? `${module}.${fnIdent}`;
      out.push(
        new Descriptor({
          id: `tool-${key}`,
          kind: BoundaryKind.TOOL_EXEC,
          matchCall: target,
          emitName: `${proj(module)}.${key}`,
        }),
      );
    }

    // 3) fallback: a free function that wraps an execution sink, if not already a tool.
    for (const fn of funcs) {
      if (fn.name.startsWith("_") || fn.typeName !== null) {
        continue;
      }
      const body = source.slice(fn.bodyOpen, fn.bodyClose);
      if (
        EXEC_SINKS.some((s) => body.includes(s)) &&
        !out.some((d) => d.matchCall.endsWith(`.${fn.name}`))
      ) {
        out.push(
          new Descriptor({
            id: `tool-${fn.name}`,
            kind: BoundaryKind.TOOL_EXEC,
            matchCall: `${module}.${fn.name}`,
            emitName: `${proj(module)}.${fn.name}`,
          }),
        );
      }
    }
    return dedupe(out);
  }

  // ------------------------------------------------------------- localization (Phase B)
  override analyze(path: string, source: string, descriptors: Descriptor[]): Boundary[] {
    const module = moduleName(path);
    const funcs = new Map<string, Func>();
    for (const f of scanFunctions(source)) {
      funcs.set(f.name, f);
    }
    const boundaries: Boundary[] = [];
    for (const d of descriptors) {
      if (!targetsModule(d.matchCall, module)) {
        continue;
      }
      const segs = d.matchCall.split(".");
      const name = segs[segs.length - 1]!;
      const fn = funcs.get(name);
      if (fn === undefined) {
        continue;
      }
      boundaries.push(this.analyzeFn(d, fn, module, path, source));
    }
    return boundaries;
  }

  private analyzeFn(
    d: Descriptor,
    fn: Func,
    module: string,
    path: string,
    source: string,
  ): Boundary {
    const rng = new Range(
      path,
      byteOf(source, fn.headerChar),
      byteOf(source, fn.bodyClose + 1),
      (source.slice(0, fn.headerChar).match(/\n/g)?.length ?? 0) + 1,
    );
    const b = new Boundary({
      descriptorId: d.id,
      kind: d.kind,
      path,
      funcName: fn.name,
      call: d.matchCall,
      range: rng,
      completeOutputFields: [...d.outputPaths],
      toolsCovered: d.kind === BoundaryKind.TOOL_EXEC ? [d.id.replaceAll("tool-", "")] : [],
      providerOrFramework: proj(module),
      source: Source.SPEC,
    });
    b.emitName = d.emitName;
    const body = source.slice(fn.bodyOpen, fn.bodyClose);

    // already fixed? (idempotency at the analysis level). The untraced marker sits above the
    // header, so check the whole source by per-function tag plus the body wrappers.
    if (alreadyFixed(source, body, fn.name)) {
      return b;
    }
    if (d.kind === BoundaryKind.LLM) {
      return b; // gateway already traced -> covered (kept for drift)
    }

    if (!b.completeOutputFields.length) {
      b.completeOutputFields = inferOutputFields(source, fn);
    }

    const traced = SPAN_STARTERS.some((s) => body.includes(s)) || hasInstrumentAttr(source, fn);
    const hop = HOP_SIGNATURES.some((s) => body.includes(s));

    // off_context: work offloaded across a spawned task/pool that creates its own span
    if (hop && traced) {
      const ctor = findPoolCtor(source);
      if (ctor !== null && !poolAlreadyWrapped(source)) {
        b.failureModes = [FailureMode.OFF_CONTEXT];
        b.poolCtorRange = ctor;
        b.existingSpanName = spanName(body);
        return b;
      }
    }

    // lossy: traced but records a truncation of a complete value
    if (traced) {
      const lossy = findLossy(source, fn);
      if (lossy !== null) {
        const [value, insertByte, indent] = lossy;
        b.failureModes = [FailureMode.LOSSY_OUTPUT];
        b.spanVar = spanVar(body);
        b.completeValueExpr = value;
        b.spanBlockInsertByte = insertByte;
        b.insertIndent = indent;
        b.existingSpanName = spanName(body);
        if (!b.completeOutputFields.length) {
          b.completeOutputFields = [value];
        }
        return b;
      }
      return b; // traced + complete -> covered
    }

    // no span at the boundary -> untraced
    b.failureModes = [FailureMode.UNTRACED];
    b.decoratorInsertByte = byteOf(source, fn.headerChar);
    b.insertIndent = fn.indent;
    return b;
  }

  // --------------------------------------------------------------------- fix emission
  override emitFix(boundary: Boundary, primitive: FixPrimitive, source: string): CodeEdit | null {
    const importByte = importInsertOffset(source);
    const importHunk: Hunk = {
      byteStart: importByte,
      byteEnd: importByte,
      newText: primitive.importLine + "\n",
      tag: primitive.importLine,
    };

    if (primitive.failureMode === FailureMode.UNTRACED && boundary.decoratorInsertByte !== null) {
      const at = boundary.decoratorInsertByte;
      const indent = boundary.insertIndent ?? "";
      const tag = `gigaphone:trace:${boundary.funcName}`;
      const deco = `${indent}#[${primitive.decorator}]  // ${tag}\n`;
      return {
        path: boundary.path,
        hunks: [importHunk, { byteStart: at, byteEnd: at, newText: deco, tag }],
        description: `trace untraced boundary \`${boundary.funcName}\` (${primitive.backendId})`,
      };
    }

    if (primitive.failureMode === FailureMode.OFF_CONTEXT && boundary.poolCtorRange) {
      const [start, end] = boundary.poolCtorRange;
      const orig = Buffer.from(source, "utf-8").subarray(start, end).toString("utf-8");
      const tag = `gigaphone:ctx:${boundary.funcName}`;
      const newText = `${primitive.executorWrapper}(${orig}) /* ${tag} */`;
      return {
        path: boundary.path,
        hunks: [importHunk, { byteStart: start, byteEnd: end, newText, tag }],
        description:
          `restore context across the spawned task/pool for \`${boundary.funcName}\` ` +
          `(${primitive.backendId})`,
      };
    }

    if (
      primitive.failureMode === FailureMode.LOSSY_OUTPUT &&
      boundary.spanBlockInsertByte !== null
    ) {
      const at = boundary.spanBlockInsertByte;
      const indent = boundary.insertIndent ?? "";
      const fields = primitive.outputFields?.length
        ? [...primitive.outputFields]
        : boundary.completeOutputFields;
      const tag = `gigaphone:complete:${boundary.funcName}`;
      const line = (primitive.attrSetterTemplate ?? "")
        .replace("{span}", String(boundary.spanVar))
        .replace("{value}", String(boundary.completeValueExpr))
        .replace("{fields}", "&" + pyReprStrList(fields));
      return {
        path: boundary.path,
        hunks: [
          importHunk,
          { byteStart: at, byteEnd: at, newText: `${indent}${line}  // ${tag}\n`, tag },
        ],
        description: `record complete output for \`${boundary.funcName}\` (${primitive.backendId})`,
      };
    }
    return null;
  }
}

// --- module-level helpers -------------------------------------------------------------
function registryEntries(source: string): Array<[string, string]> {
  /** A `match <scrutinee> { "tool" => tool_fn(..), .. }` dispatch -> [(key, fnIdent)]. */
  const entries: Array<[string, string]> = [];
  for (const m of source.matchAll(/\bmatch\s+[A-Za-z_][\w.]*\s*\{/g)) {
    const brace = source.indexOf("{", m.index + m[0].length - 1);
    const close = matchBrace(source, brace, "{", "}");
    if (close === -1) {
      continue;
    }
    const inner = source.slice(brace + 1, close);
    for (const arm of inner.matchAll(/"([^"]+)"\s*=>\s*([A-Za-z_]\w*)\s*\(/g)) {
      entries.push([arm[1]!, arm[2]!]);
    }
  }
  return entries;
}

function targetsModule(matchCall: string, module: string): boolean {
  return matchCall === module || matchCall.startsWith(module + ".");
}

function alreadyFixed(source: string, funcBody: string, name: string): boolean {
  const byTag = [`gigaphone:trace:${name}`, `gigaphone:ctx:${name}`, `gigaphone:complete:${name}`];
  const byCall = ["gigaphone_trace(", "gigaphone_complete("];
  return byTag.some((t) => source.includes(t)) || byCall.some((c) => funcBody.includes(c));
}

function hasInstrumentAttr(source: string, fn: Func): boolean {
  /** A `#[instrument]` / `#[tracing::instrument]` attribute on the lines above the fn. */
  const above = source.slice(Math.max(0, fn.headerChar - 200), fn.headerChar);
  return /#\[\s*(?:tracing::)?instrument\b/.test(above);
}

function spanName(body: string): string | null {
  const m = /(?:info_span|debug_span|trace_span|warn_span|error_span|span)!\s*\(/.exec(body);
  if (!m) {
    return null;
  }
  const s = /!\s*\(\s*[^,)"]*"([^"]+)"/.exec(body.slice(m.index));
  return s ? s[1]! : null;
}

function spanVar(body: string): string {
  const m = /\blet\s+([A-Za-z_]\w*)\s*=\s*[^;]*?(?:info_span|debug_span|span)!/.exec(body);
  return m ? m[1]! : "span";
}

function findPoolCtor(source: string): [number, number] | null {
  const m = POOL_CTOR_RE.exec(source);
  if (!m) {
    return null;
  }
  const paren = source.indexOf("(", m.index);
  const close = matchBrace(source, paren, "(", ")");
  if (close === -1) {
    return null;
  }
  return [byteOf(source, m.index), byteOf(source, close + 1)];
}

function poolAlreadyWrapped(source: string): boolean {
  return source.includes("gigaphone_propagate(") || source.includes("gigaphone:ctx:");
}

function findLossy(source: string, fn: Func): [string, number, string] | null {
  /** A `&value[..n]` / `value.chars().take(n)` truncation inside the span block. */
  const body = source.slice(fn.bodyOpen, fn.bodyClose);
  const m = SLICE_RE.exec(body) ?? TAKE_RE.exec(body);
  if (!m) {
    return null;
  }
  const value = m[1]!;
  const absIdx = fn.bodyOpen + m.index;
  let lineEnd = source.indexOf("\n", absIdx);
  if (lineEnd === -1) {
    lineEnd = fn.bodyClose;
  }
  const indent = indentOf(source, lineStart(source, absIdx));
  return [value, byteOf(source, lineEnd + 1), indent];
}

function inferOutputFields(source: string, fn: Func): string[] {
  /** Complete-result fields from a returned struct literal `Name { a, b: x, c }`. */
  const body = source.slice(fn.bodyOpen, fn.bodyClose);
  const matches = [...body.matchAll(STRUCT_LIT_RE)];
  if (!matches.length) {
    return [];
  }
  const fields: string[] = [];
  const last = matches[matches.length - 1]!;
  for (const part of last[2]!.split(",")) {
    const key = part.split(":")[0]!.trim();
    if (/^[A-Za-z_]\w*$/.test(key)) {
      fields.push(key);
    }
  }
  return fields;
}

function importInsertOffset(source: string): number {
  /** After leading line/block-comment header lines and any leading `use`/`extern crate`. */
  let idx = 0;
  for (const line of splitLinesKeepEnds(source)) {
    const stripped = line.trim();
    const prefixed = ["use ", "extern crate ", "//", "/*", "*", "*/"].some((p) =>
      stripped.startsWith(p),
    );
    if (prefixed || !stripped) {
      idx += line.length;
    } else {
      break;
    }
  }
  return byteOf(source, idx);
}

function dedupe(descriptors: Descriptor[]): Descriptor[] {
  const seen = new Map<string, Descriptor>();
  for (const d of descriptors) {
    if (!seen.has(d.matchCall)) {
      seen.set(d.matchCall, d);
    }
  }
  return [...seen.values()];
}

function splitLinesKeepEnds(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) {
    out.push(s.slice(start));
  }
  return out;
}

function pyReprStrList(items: string[]): string {
  return "[" + items.map(pyReprStr).join(", ") + "]";
}

function pyReprStr(s: string): string {
  const escaped = s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}
