/**
 * TypeScript language pack.
 *
 * Function scanning has two interchangeable backends behind `scanFunctions` (ADR-0007): a
 * **precise** scanner (`./precise`) backed by the TypeScript compiler API when `typescript` is
 * importable — AST-precise and robust to generics/template braces/no-paren arrows — falling
 * back to a **lexical** regex/brace scanner when it is not, so the pack stays usable without a
 * full compiler install. Both produce the same `Func` records (CHAR indices into `source`), so
 * discovery, analysis, and codemod emission are parser-agnostic.
 *
 * It mirrors `PythonPack`: `discover` proposes descriptors, `analyze` classifies failure
 * modes, `emitFix` renders idempotent, byte-accurate codemods.
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
import { LanguagePack } from "../../interfaces/languagePack.js";
import * as precise from "./precise.js";

// --- built-in anchor catalog (DESIGN §7.1), TypeScript flavour -----------------------
const GATEWAY_CLASS_HINTS = ["llm", "gateway", "client", "model"];
const GATEWAY_METHODS = new Set(["chat", "complete", "completion", "generate", "create", "invoke"]);
// span starters across OTel / OpenInference / vendor SDKs in TS
const SPAN_STARTERS = ["startSpan", "startActiveSpan", "withSpan", "start_as_current_span"];
// execution sinks: trace the wrapping function, never inside (DESIGN §3)
const EXEC_SINKS = [
  "execSync",
  "exec(",
  "execFile",
  "spawn(",
  "spawnSync",
  "runInContext",
  "runInNewContext",
  "isolated-vm",
  "ivm.",
];
// context-hop signatures for TS's concurrency model (DESIGN §7.1, §10).
const HOP_SIGNATURES = [
  "new Worker",
  ".postMessage(",
  ".submit(",
  ".run(",
  "runInWorker(",
  "pool.",
];
const POOL_CTOR_RE = /new\s+[A-Za-z_$][\w$]*?(?:Worker|Pool)[A-Za-z_$]*\s*\(/;
const TRUNCATION_RE = /([A-Za-z_$][\w$.]*)\s*\.\s*(?:slice|substring|substr)\s*\(\s*0\s*,/;
const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "await",
  "do",
]);
const MODIFIERS = new Set([
  "async",
  "public",
  "private",
  "protected",
  "static",
  "get",
  "set",
  "readonly",
  "override",
  "abstract",
]);

/** One scanned function — CHAR indices into `source` (mirrors the Python `_Func`). */
export interface Func {
  name: string;
  headerChar: number; // index of the line start of the function header
  bodyOpen: number; // index of the body `{`
  bodyClose: number; // index of the matching `}`
  className: string | null;
  indent: string;
}

const _encoder = new TextEncoder();

function byteOffset(source: string, charIdx: number): number {
  return _encoder.encode(source.slice(0, charIdx)).length;
}

function lineStart(source: string, charIdx: number): number {
  return source.lastIndexOf("\n", charIdx - 1) + 1;
}

function indentOf(source: string, charIdx: number): string {
  const ls = lineStart(source, charIdx);
  const line = source.slice(ls, charIdx);
  return line.slice(0, line.length - line.replace(/^\s+/, "").length);
}

/** Index of the matching close char, skipping strings and comments. -1 if unbalanced. */
function matchChar(source: string, openIdx: number, openCh: string, closeCh: string): number {
  let depth = 0;
  let i = openIdx;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(source, i);
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
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function skipString(source: string, i: number): number {
  const quote = source[i];
  i += 1;
  const n = source.length;
  while (i < n) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return n;
}

/** Given the `(` of a param list, return [bodyOpenIdx, bodyCloseIdx]. */
function bodyAfter(source: string, parenOpen: number): [number, number] | null {
  const parenClose = matchChar(source, parenOpen, "(", ")");
  if (parenClose === -1) return null;
  const brace = source.indexOf("{", parenClose);
  if (brace === -1) return null;
  const close = matchChar(source, brace, "{", "}");
  if (close === -1) return null;
  return [brace, close];
}

const FREE_FN_RE =
  /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\()/dg;
const ARROW_RE = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=][^=]*?=\s*(?:async\s*)?(\()/dg;
const CLASS_RE = /\bclass\s+([A-Za-z_$][\w$]*)/dg;
const METHOD_RE =
  /(?:public|private|protected|static|async|get|set|\s)*?([A-Za-z_$][\w$]*)\s*(\()/dg;

function groupStart(m: RegExpMatchArray, group: number): number {
  const indices = (m as unknown as { indices?: Array<[number, number] | undefined> }).indices;
  const gi = indices?.[group];
  return gi ? gi[0] : -1;
}

export function scanFunctions(source: string): Func[] {
  if (precise.available()) {
    try {
      return precise.scan(source);
    } catch {
      // never let a parse hiccup break the pack — degrade to the lexical scanner.
    }
  }
  return scanFunctionsLexical(source);
}

export function scanFunctionsLexical(source: string): Func[] {
  const funcs: Func[] = [];
  const seen = new Set<number>();

  for (const rx of [FREE_FN_RE, ARROW_RE]) {
    for (const m of source.matchAll(rx)) {
      const paren = groupStart(m, 2);
      const body = bodyAfter(source, paren);
      if (body === null) continue;
      funcs.push({
        name: m[1] as string,
        headerChar: lineStart(source, m.index),
        bodyOpen: body[0],
        bodyClose: body[1],
        className: null,
        indent: indentOf(source, m.index),
      });
      seen.add(body[0]);
    }
  }

  // class methods
  for (const cm of source.matchAll(CLASS_RE)) {
    const cls = cm[1] as string;
    const clsEnd = cm.index + cm[0].length;
    const brace = source.indexOf("{", clsEnd);
    if (brace === -1) continue;
    const clsClose = matchChar(source, brace, "{", "}");
    if (clsClose === -1) continue;
    const off = brace + 1;
    const inner = source.slice(off, clsClose);
    for (const mm of inner.matchAll(METHOD_RE)) {
      const name = mm[1] as string;
      if (KEYWORDS.has(name) || name === cls) continue;
      const paren = groupStart(mm, 2) + off;
      const body = bodyAfter(source, paren);
      if (body === null || seen.has(body[0])) continue;
      const nameStart = groupStart(mm, 1) + off;
      // avoid matching call-sites: a method header sits at line start, preceded only by
      // method modifiers (async/public/...), never by `const x = obj.` etc.
      const prefix = source.slice(lineStart(source, nameStart), nameStart).trim();
      if (prefix && !prefix.split(/\s+/).every((tok) => MODIFIERS.has(tok))) continue;
      funcs.push({
        name,
        headerChar: lineStart(source, nameStart),
        bodyOpen: body[0],
        bodyClose: body[1],
        className: cls,
        indent: indentOf(source, nameStart),
      });
      seen.add(body[0]);
    }
  }
  return funcs;
}

function moduleName(path: string): string {
  let parts = path.replace(/\\/g, "/").split("/");
  const last = parts[parts.length - 1] as string;
  for (const ext of [".tsx", ".ts"]) {
    if (last.endsWith(ext)) {
      parts[parts.length - 1] = last.slice(0, last.length - ext.length);
      break;
    }
  }
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "app" || parts[i] === "src") {
      parts = parts.slice(i);
      break;
    }
  }
  if (parts.length && parts[0] === "src") parts = parts.slice(1);
  return parts.filter((p) => p && p !== "index").join(".");
}

function proj(module: string): string {
  return module.split(".")[0] || "app";
}

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/** Map imported identifier -> dotted module path (best-effort, lexical). */
function importMap(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(IMPORT_RE)) {
    const mod = moduleFromSpecifier(m[2] as string);
    for (const raw of (m[1] as string).split(",")) {
      const name = raw.trim().split(" as ").pop()?.trim() ?? "";
      if (name) out.set(name, `${mod}.${name}`);
    }
  }
  return out;
}

function moduleFromSpecifier(spec: string): string {
  let s = spec.replace(/^[./]+/, "").replace(/\//g, ".");
  for (const ext of [".tsx", ".ts", ".js"]) {
    if (s.endsWith(ext)) s = s.slice(0, s.length - ext.length);
  }
  return s || "app";
}

export class TypeScriptPack extends LanguagePack {
  readonly id = "typescript";
  readonly extensions = [".ts", ".tsx"] as const;

  // ------------------------------------------------------------- discovery (Phase A)
  override discover(path: string, source: string): Descriptor[] {
    const module = moduleName(path);
    const imports = importMap(source);
    const funcs = scanFunctions(source);
    const out: Descriptor[] = [];

    // 1) hand-rolled LLM gateway.
    for (const cm of source.matchAll(CLASS_RE)) {
      const cls = cm[1] as string;
      if (!GATEWAY_CLASS_HINTS.some((h) => cls.toLowerCase().includes(h))) continue;
      for (const fn of funcs) {
        if (fn.className === cls && GATEWAY_METHODS.has(fn.name)) {
          const header = source.slice(fn.headerChar, fn.bodyOpen);
          const arg = ["messages", "prompt", "input"].find((a) => header.includes(a)) ?? null;
          out.push(
            new Descriptor({
              id: `${cls.toLowerCase()}-gateway`,
              kind: BoundaryKind.LLM,
              matchCall: `${module}.${cls}.${fn.name}`,
              inputArg: arg,
              emitName: `${proj(module)}.llm`,
            }),
          );
          break;
        }
      }
    }

    // 2) tool dispatch registry: `const TOOLS = { name: fn, ... }` (object literal).
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

    // 3) fallback: a function that wraps an execution sink, if not already a tool.
    for (const fn of funcs) {
      if (fn.name.startsWith("_") || fn.className !== null) continue;
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
    for (const f of scanFunctions(source)) funcs.set(f.name, f);
    const boundaries: Boundary[] = [];
    for (const d of descriptors) {
      if (!targetsModule(d.matchCall, module)) continue;
      const name = d.matchCall.slice(d.matchCall.lastIndexOf(".") + 1);
      const fn = funcs.get(name);
      if (fn === undefined) continue;
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
      byteOffset(source, fn.headerChar),
      byteOffset(source, fn.bodyClose + 1),
      countNewlines(source.slice(0, fn.headerChar)) + 1,
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

    if (alreadyFixed(source, body, fn.name)) return b;
    if (d.kind === BoundaryKind.LLM) return b; // gateway already traced -> covered

    if (b.completeOutputFields.length === 0) {
      b.completeOutputFields = inferOutputFields(source, fn);
    }

    const traced = SPAN_STARTERS.some((s) => body.includes(s));
    const hop = HOP_SIGNATURES.some((s) => body.includes(s));

    // off_context: work offloaded across a worker/pool that creates its own span (orphan)
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
        if (b.completeOutputFields.length === 0) b.completeOutputFields = [value];
        return b;
      }
      return b; // traced + complete -> covered
    }

    // no span at the boundary -> untraced
    b.failureModes = [FailureMode.UNTRACED];
    b.decoratorInsertByte = byteOffset(source, fn.headerChar);
    b.insertIndent = fn.indent;
    return b;
  }

  // --------------------------------------------------------------------- fix emission
  private locateFn(source: string, boundary: Boundary): Func | null {
    const target = boundary.decoratorInsertByte;
    const funcs = scanFunctions(source);
    for (const f of funcs) {
      if (byteOffset(source, f.headerChar) === target) return f;
    }
    return funcs.find((f) => f.name === boundary.funcName) ?? null;
  }

  override emitFix(boundary: Boundary, primitive: FixPrimitive, source: string): CodeEdit | null {
    const importByte = importInsertOffset(source);
    const importHunk: Hunk = {
      byteStart: importByte,
      byteEnd: importByte,
      newText: `${primitive.importLine}\n`,
      tag: primitive.importLine,
    };

    if (primitive.failureMode === FailureMode.UNTRACED && boundary.decoratorInsertByte !== null) {
      // TS has no portable function decorator, so trace by wrapping the body in the curried
      // `gigaphoneTrace(opts)(fn)` higher-order call. Async-correct: the arrow mirrors the
      // boundary's own async-ness.
      const fn = this.locateFn(source, boundary);
      if (fn === null) return null;
      const header = source.slice(fn.headerChar, fn.bodyOpen);
      const arrow = /\basync\b/.test(header) ? "async () =>" : "() =>";
      const tag = `gigaphone:trace:${boundary.funcName}`;
      const endTag = `${tag}:end`;
      const openAt = byteOffset(source, fn.bodyOpen + 1);
      const closeAt = byteOffset(source, fn.bodyClose);
      const openText = ` return ${primitive.decorator}(${arrow} { /* ${tag} */`;
      const closeText = ` }); /* ${endTag} */`;
      return {
        path: boundary.path,
        hunks: [
          importHunk,
          { byteStart: openAt, byteEnd: openAt, newText: openText, tag },
          { byteStart: closeAt, byteEnd: closeAt, newText: closeText, tag: endTag },
        ],
        description: `trace untraced boundary \`${boundary.funcName}\` (${primitive.backendId})`,
      };
    }

    if (primitive.failureMode === FailureMode.OFF_CONTEXT && boundary.poolCtorRange) {
      const [start, end] = boundary.poolCtorRange;
      const bytes = _encoder.encode(source);
      const orig = new TextDecoder().decode(bytes.slice(start, end));
      const tag = `gigaphone:ctx:${boundary.funcName}`;
      const newText = `${primitive.executorWrapper}(${orig}) /* ${tag} */`;
      return {
        path: boundary.path,
        hunks: [importHunk, { byteStart: start, byteEnd: end, newText, tag }],
        description:
          `restore context across the worker/pool for \`${boundary.funcName}\` ` +
          `(${primitive.backendId})`,
      };
    }

    if (
      primitive.failureMode === FailureMode.LOSSY_OUTPUT &&
      boundary.spanBlockInsertByte !== null
    ) {
      const at = boundary.spanBlockInsertByte;
      const indent = boundary.insertIndent ?? "";
      const fields =
        primitive.outputFields && primitive.outputFields.length > 0
          ? [...primitive.outputFields]
          : boundary.completeOutputFields;
      const tag = `gigaphone:complete:${boundary.funcName}`;
      const line = (primitive.attrSetterTemplate ?? "")
        .replaceAll("{span}", boundary.spanVar ?? "")
        .replaceAll("{value}", boundary.completeValueExpr ?? "")
        .replaceAll("{fields}", pyReprList(fields));
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
const TOOLS_RE = /\b(?:const|let|var)\s+TOOLS\b[^=]*=\s*\{/;
const REGISTRY_PAIR_RE = /([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g;

/** `const TOOLS = { name: fn, ... }` -> [(name, fnIdent)]. */
function registryEntries(source: string): Array<[string, string]> {
  const m = TOOLS_RE.exec(source);
  if (!m) return [];
  const brace = source.indexOf("{", m.index + m[0].length - 1);
  const close = matchChar(source, brace, "{", "}");
  if (close === -1) return [];
  const inner = source.slice(brace + 1, close);
  const entries: Array<[string, string]> = [];
  for (const pair of inner.matchAll(REGISTRY_PAIR_RE)) {
    entries.push([pair[1] as string, pair[2] as string]);
  }
  return entries;
}

function targetsModule(matchCall: string, module: string): boolean {
  return matchCall === module || matchCall.startsWith(`${module}.`);
}

function alreadyFixed(source: string, funcBody: string, name: string): boolean {
  const byTag = [`gigaphone:trace:${name}`, `gigaphone:ctx:${name}`, `gigaphone:complete:${name}`];
  const byCall = ["gigaphoneTrace(", "gigaphoneComplete("];
  return byTag.some((t) => source.includes(t)) || byCall.some((c) => funcBody.includes(c));
}

function spanName(body: string): string | null {
  const m = /(?:startSpan|startActiveSpan|withSpan)\s*\(\s*["'`]([^"'`]+)["'`]/.exec(body);
  return m ? (m[1] as string) : null;
}

function spanVar(body: string): string {
  const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*?(?:startSpan|startActiveSpan)/.exec(
    body,
  );
  return m ? (m[1] as string) : "span";
}

function findPoolCtor(source: string): [number, number] | null {
  const m = POOL_CTOR_RE.exec(source);
  if (!m) return null;
  const paren = source.indexOf("(", m.index);
  const close = matchChar(source, paren, "(", ")");
  if (close === -1) return null;
  return [byteOffset(source, m.index), byteOffset(source, close + 1)];
}

function poolAlreadyWrapped(source: string): boolean {
  return source.includes("gigaphonePropagate(") || source.includes("gigaphone:ctx:");
}

/** A `setAttribute(..., x.slice(0,n))`-style truncation inside the span block. */
function findLossy(source: string, fn: Func): [string, number, string] | null {
  const body = source.slice(fn.bodyOpen, fn.bodyClose);
  const m = TRUNCATION_RE.exec(body);
  if (!m) return null;
  const value = m[1] as string;
  const absIdx = fn.bodyOpen + m.index;
  let lineEnd = source.indexOf("\n", absIdx);
  if (lineEnd === -1) lineEnd = fn.bodyClose;
  const indent = indentOf(source, lineStart(source, absIdx));
  return [value, byteOffset(source, lineEnd + 1), indent];
}

/** Complete-result fields from a returned object literal `return { a, b, c }`. */
function inferOutputFields(source: string, fn: Func): string[] {
  const body = source.slice(fn.bodyOpen, fn.bodyClose);
  const m = /return\s*\{([^}]*)\}/.exec(body);
  if (!m) return [];
  const fields: string[] = [];
  for (const part of (m[1] as string).split(",")) {
    const key = (part.split(":")[0] ?? "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(key)) fields.push(key);
  }
  return fields;
}

function importInsertOffset(source: string): number {
  let idx = 0;
  const n = source.length;
  // skip a leading block comment
  if (source.slice(0, n).replace(/^\s+/, "").startsWith("/*")) {
    const end = source.indexOf("*/");
    if (end !== -1) {
      const nl = source.indexOf("\n", end);
      idx = nl !== -1 ? nl + 1 : end + 2;
    }
  }

  const lines = splitlinesKeepends(source.slice(idx));
  let i = 0;
  while (i < lines.length) {
    const stripped = (lines[i] as string).trim();
    if (
      stripped === "" ||
      stripped.startsWith("//") ||
      stripped.startsWith("/*") ||
      stripped.startsWith("*") ||
      stripped.startsWith("*/")
    ) {
      idx += (lines[i] as string).length;
      i += 1;
      continue;
    }
    if (stripped.startsWith("import")) {
      while (i < lines.length) {
        const ln = lines[i] as string;
        idx += ln.length;
        const tail = ln.replace(/\s+$/, "");
        const done =
          tail.endsWith(";") ||
          tail.endsWith('"') ||
          tail.endsWith("'") ||
          (ln.includes("from ") && (ln.includes('"') || ln.includes("'")));
        i += 1;
        if (done) break;
      }
      continue;
    }
    break;
  }
  return byteOffset(source, idx);
}

function dedupe(descriptors: Descriptor[]): Descriptor[] {
  const seen = new Map<string, Descriptor>();
  for (const d of descriptors) {
    if (!seen.has(d.matchCall)) seen.set(d.matchCall, d);
  }
  return [...seen.values()];
}

function countNewlines(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") count += 1;
  return count;
}

/** Split keeping line terminators (mirrors Python `str.splitlines(keepends=True)`). */
function splitlinesKeepends(s: string): string[] {
  const out: string[] = [];
  const re = /\r\n|\r|\n/g;
  let last = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
  while ((m = re.exec(s)) !== null) {
    const endIdx = m.index + m[0].length;
    out.push(s.slice(last, endIdx));
    last = endIdx;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** Python `repr()` of a string (single-quote preferred). Used for `repr(list_of_fields)`. */
function pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let body = s.replace(/\\/g, "\\\\");
  body = quote === "'" ? body.replace(/'/g, "\\'") : body.replace(/"/g, '\\"');
  return quote + body + quote;
}

function pyReprList(items: string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}
