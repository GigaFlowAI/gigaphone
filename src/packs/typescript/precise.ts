/**
 * Optional precise function scanner for the TypeScript pack (DESIGN §7; ADR-0007).
 *
 * The Python pack used a tree-sitter CST scanner; here we use the **TypeScript compiler API**
 * instead (a devDependency loaded lazily via `createRequire` so the pack stays usable when
 * `typescript` is not importable — e.g. a pure-runtime install). When available, the pack
 * scans functions from a real AST instead of the lexical regex/brace fallback — immune to the
 * lexical limitations (generics carrying `{`/`>` in the header, bare arrow consts with no
 * parenthesised parameter list).
 *
 * `scan` returns the same record shape the lexical scanner produces — CHAR indices into
 * `source` — so the rest of the pack is parser-agnostic. TypeScript node positions are
 * UTF-16 code-unit offsets, i.e. JS string indices, which is exactly what the lexical scanner
 * (also JS-string based) uses, so the two backends agree index-for-index on shared source.
 */

import { createRequire } from "node:module";
import type * as TSApi from "typescript";

const _require = createRequire(import.meta.url);

let _tsCache: typeof TSApi | null | undefined;
// null = auto-detect; true/false = force on/off (used by the dispatcher's fallback tests,
// mirroring the Python test that monkeypatches `_treesitter.available`).
let _override: boolean | null = null;

function loadTs(): typeof TSApi | null {
  if (_tsCache !== undefined) return _tsCache;
  try {
    _tsCache = _require("typescript") as typeof TSApi;
  } catch {
    _tsCache = null;
  }
  return _tsCache;
}

/** Force the precise backend on/off (test seam). Pass null to restore auto-detection. */
export function setBackendOverride(value: boolean | null): void {
  _override = value;
}

/** Whether the TypeScript compiler API is importable (and not forced off). */
export function available(): boolean {
  if (_override !== null) return _override;
  return loadTs() !== null;
}

/** One scanned function record — CHAR indices into `source` (mirrors the lexical `_Func`). */
export interface PreciseRec {
  name: string;
  headerChar: number;
  bodyOpen: number;
  bodyClose: number;
  className: string | null;
  indent: string;
}

/**
 * Return function records `{name, headerChar, bodyOpen, bodyClose, className, indent}` with
 * CHAR indices into `source`. Collected node kinds (block-bodied only, mirroring the lexical
 * scanner's coverage): free `FunctionDeclaration`s, class `MethodDeclaration`s (with the
 * enclosing class name), and `const`/`let` arrow functions bound to a `VariableDeclaration`.
 */
export function scan(source: string): PreciseRec[] {
  const ts = loadTs();
  if (ts === null) throw new Error("typescript compiler API not available");

  // ScriptKind.TS (not TSX) mirrors tree-sitter's `language_typescript()` grammar, so generic
  // headers like `<T extends { id: number }>` parse without the JSX `<…>` ambiguity.
  const sf = ts.createSourceFile(
    "scan.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );

  const lineStartChar = (c: number): number => source.lastIndexOf("\n", c - 1) + 1;
  const indentAt = (c: number): string => {
    const line = source.slice(lineStartChar(c), c);
    return line.slice(0, line.length - line.replace(/^\s+/, "").length);
  };

  const out: PreciseRec[] = [];

  const emit = (
    nameNode: TSApi.Node | undefined,
    bodyNode: TSApi.Node | undefined,
    declStart: number,
    className: string | null,
  ): void => {
    // block-bodied only — mirrors tree-sitter's `body_node.type === "statement_block"`.
    if (!nameNode || !bodyNode || !ts.isBlock(bodyNode)) return;
    out.push({
      name: nameNode.getText(sf),
      headerChar: lineStartChar(declStart),
      bodyOpen: bodyNode.getStart(sf), // position of the `{`
      bodyClose: bodyNode.getEnd() - 1, // position of the matching `}`
      className,
      indent: indentAt(declStart),
    });
  };

  const visit = (node: TSApi.Node, className: string | null): void => {
    if (ts.isFunctionDeclaration(node)) {
      emit(node.name, node.body, node.getStart(sf), null);
    } else if (ts.isClassDeclaration(node)) {
      const clsName = node.name ? node.name.getText(sf) : null;
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m)) {
          emit(m.name, m.body, m.getStart(sf), clsName);
        }
      }
      ts.forEachChild(node, (c) => visit(c, clsName));
      return;
    } else if (ts.isVariableDeclaration(node)) {
      const init = node.initializer;
      if (init && ts.isArrowFunction(init)) {
        emit(node.name, init.body, node.getStart(sf), null);
      }
    }
    ts.forEachChild(node, (c) => visit(c, className));
  };

  visit(sf, null);
  return out;
}
