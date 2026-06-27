/**
 * Python AST access for the TypeScript Python language pack (ADR-0007 port).
 *
 * The engine is Node/TypeScript, so we cannot use the stdlib `ast` module directly. Instead
 * we shell out to the bundled `astDump.py` helper (which runs `ast.parse` and emits a generic
 * JSON node serialization) and reimplement the pack logic over that JSON. This module owns:
 *   - the `Node` shape + type guards,
 *   - the loader (`parse`) that runs python3 over stdin,
 *   - `walk` (the `ast.walk` BFS-generator equivalent),
 *   - `iterChildNodes` (the `ast.iter_child_nodes` equivalent, `_fields`-driven),
 *   - `attrChain` (the pack's `_attr_chain` dotted-name renderer),
 *   - `unparse` (a faithful subset of `ast.unparse` for the expressions the pack renders),
 *   - `multilineStringInteriorLines` (python `tokenize`-backed, for the native body-wrap).
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./astDump.py", import.meta.url));

/** A serialized Python AST node. Field values live alongside the position attrs; `_fields`
 * names the AST fields (in order) so the walk can mirror `ast.iter_child_nodes`. */
export interface Node {
  type: string;
  _fields: string[];
  lineno?: number;
  col_offset?: number;
  end_lineno?: number;
  end_col_offset?: number;
  // biome-ignore lint/suspicious/noExplicitAny: generic AST field bag
  [field: string]: any;
}

/** A non-JSON Constant payload (bytes / complex / Ellipsis), carried as its `repr`. */
export interface ReprValue {
  __repr__: string;
}

export function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Node).type === "string" &&
    Array.isArray((value as Node)._fields)
  );
}

export function isReprValue(value: unknown): value is ReprValue {
  return (
    typeof value === "object" && value !== null && typeof (value as ReprValue).__repr__ === "string"
  );
}

/**
 * Parse Python source by shelling out to `astDump.py`. Returns the root `Module` node, or
 * `null` on a `SyntaxError` (mirrors the pack's `except SyntaxError: return []`).
 */
export function parse(source: string): Node | null {
  const out = execFileSync("python3", [SCRIPT], {
    input: source,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const tree = JSON.parse(out) as Node | { __error__: string };
  if ((tree as { __error__?: string }).__error__) return null;
  return tree as Node;
}

/** The 1-based physical line numbers interior to multi-line string tokens (python `tokenize`). */
export function multilineStringInteriorLines(source: string): Set<number> {
  const out = execFileSync("python3", [SCRIPT, "--strings"], {
    input: source,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(JSON.parse(out) as number[]);
}

/** `ast.iter_child_nodes`: yield each child AST node in `_fields` order (lists flattened). */
export function* iterChildNodes(node: Node): Generator<Node> {
  for (const field of node._fields) {
    const value = node[field];
    if (isNode(value)) {
      yield value;
    } else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) yield item;
    }
  }
}

/**
 * `ast.walk`: breadth-first over `node` and all descendants (node itself first). Uses a
 * queue with a read cursor — equivalent to the stdlib `deque` popleft/extend, so the yield
 * order matches CPython exactly (load-bearing: several helpers return the FIRST match).
 */
export function* walk(node: Node): Generator<Node> {
  const todo: Node[] = [node];
  let i = 0;
  while (i < todo.length) {
    const current = todo[i++];
    for (const child of iterChildNodes(current)) todo.push(child);
    yield current;
  }
}

/** `_attr_chain`: render a dotted name for Name/Attribute/Call chains, e.g. `a.b.c`. */
export function attrChain(node: Node | null | undefined): string {
  if (!isNode(node)) return "";
  if (node.type === "Call") return attrChain(node.func);
  if (node.type === "Attribute") return `${attrChain(node.value)}.${node.attr}`;
  if (node.type === "Name") return String(node.id);
  return "";
}

// --- ast.unparse (faithful subset for the expressions the pack renders) ----------------
// Used only for: the LLM model expr (`set_attribute("...model...", X)` arg) and the LLM
// response expr (a `return X`). Covers the realistic expression shapes; falls back to a
// best-effort placeholder for anything unhandled (flagged in the port report).

function pyReprStr(s: string): string {
  // ast.unparse prefers single quotes, switching to double only when the string contains a
  // single quote but no double quote.
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let body = s.replace(/\\/g, "\\\\");
  body = body.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  if (quote === "'") body = body.replace(/'/g, "\\'");
  else body = body.replace(/"/g, '\\"');
  return quote + body + quote;
}

function unparseConstant(node: Node): string {
  const value = node.value;
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return pyReprStr(value);
  if (typeof value === "number") return String(value);
  if (isReprValue(value)) {
    if (value.__repr__ === "Ellipsis") return "...";
    return value.__repr__;
  }
  return String(value);
}

const BINOP: Record<string, string> = {
  Add: "+",
  Sub: "-",
  Mult: "*",
  Div: "/",
  Mod: "%",
  Pow: "**",
  LShift: "<<",
  RShift: ">>",
  BitOr: "|",
  BitXor: "^",
  BitAnd: "&",
  FloorDiv: "//",
  MatMult: "@",
};
const UNARYOP: Record<string, string> = { UAdd: "+", USub: "-", Not: "not ", Invert: "~" };
const BOOLOP: Record<string, string> = { And: "and", Or: "or" };
const CMPOP: Record<string, string> = {
  Eq: "==",
  NotEq: "!=",
  Lt: "<",
  LtE: "<=",
  Gt: ">",
  GtE: ">=",
  Is: "is",
  IsNot: "is not",
  In: "in",
  NotIn: "not in",
};

export function unparse(node: Node | null | undefined): string {
  if (!isNode(node)) return "";
  switch (node.type) {
    case "Constant":
      return unparseConstant(node);
    case "Name":
      return String(node.id);
    case "Attribute":
      return `${unparse(node.value)}.${node.attr}`;
    case "Starred":
      return `*${unparse(node.value)}`;
    case "Call": {
      const args = (node.args as Node[]).map((a) => unparse(a));
      const kwargs = (node.keywords as Node[]).map((k) =>
        k.arg ? `${k.arg}=${unparse(k.value)}` : `**${unparse(k.value)}`,
      );
      return `${unparse(node.func)}(${[...args, ...kwargs].join(", ")})`;
    }
    case "Subscript":
      return `${unparse(node.value)}[${unparse(node.slice)}]`;
    case "Slice": {
      const lower = node.lower ? unparse(node.lower) : "";
      const upper = node.upper ? unparse(node.upper) : "";
      const step = node.step ? `:${unparse(node.step)}` : "";
      return `${lower}:${upper}${step}`;
    }
    case "List":
      return `[${(node.elts as Node[]).map((e) => unparse(e)).join(", ")}]`;
    case "Tuple": {
      const elts = (node.elts as Node[]).map((e) => unparse(e));
      return elts.length === 1 ? `(${elts[0]},)` : `(${elts.join(", ")})`;
    }
    case "Set":
      return `{${(node.elts as Node[]).map((e) => unparse(e)).join(", ")}}`;
    case "Dict": {
      const parts = (node.keys as (Node | null)[]).map((k, i) =>
        k ? `${unparse(k)}: ${unparse((node.values as Node[])[i])}` : `**${unparse((node.values as Node[])[i])}`,
      );
      return `{${parts.join(", ")}}`;
    }
    case "BinOp":
      return `${unparse(node.left)} ${BINOP[node.op.type] ?? "?"} ${unparse(node.right)}`;
    case "UnaryOp": {
      const op = UNARYOP[node.op.type] ?? "?";
      return op === "not " ? `not ${unparse(node.operand)}` : `${op}${unparse(node.operand)}`;
    }
    case "BoolOp": {
      const op = ` ${BOOLOP[node.op.type] ?? "?"} `;
      return (node.values as Node[]).map((v) => unparse(v)).join(op);
    }
    case "Compare": {
      let out = unparse(node.left);
      const ops = node.ops as Node[];
      const comparators = node.comparators as Node[];
      for (let i = 0; i < ops.length; i++) {
        out += ` ${CMPOP[ops[i].type] ?? "?"} ${unparse(comparators[i])}`;
      }
      return out;
    }
    case "Await":
      return `await ${unparse(node.value)}`;
    case "IfExp":
      return `${unparse(node.body)} if ${unparse(node.test)} else ${unparse(node.orelse)}`;
    case "JoinedStr":
      return unparseJoinedStr(node);
    case "FormattedValue":
      return `{${unparse(node.value)}}`;
    default:
      return `<${node.type}>`;
  }
}

function unparseJoinedStr(node: Node): string {
  let out = "f'";
  for (const part of node.values as Node[]) {
    if (part.type === "Constant" && typeof part.value === "string") {
      out += part.value.replace(/'/g, "\\'");
    } else if (part.type === "FormattedValue") {
      out += `{${unparse(part.value)}}`;
    } else {
      out += unparse(part);
    }
  }
  return `${out}'`;
}
