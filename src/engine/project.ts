/** Project scanning — locate source files under an (optional) scope, language-neutrally. */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { packForPath } from "../packs/registry.js";

const SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "node_modules",
  ".ruff_cache",
  ".pytest_cache",
]);

export interface SourceFile {
  /** path relative to the project root (drives module naming) */
  relPath: string;
  absPath: string;
}

/** All known-language source files under `scope` (default whole repo). */
export function scan(root: string, scope?: string): SourceFile[] {
  const base = normalize(scope ? join(root, scope) : root);
  let candidates: string[] = [];
  if (statSync(base).isFile()) {
    candidates = [base];
  } else {
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push(p);
        } else {
          candidates.push(p);
        }
      }
    }
  }
  const out: SourceFile[] = [];
  for (const absPath of candidates.sort()) {
    if (packForPath(absPath) !== null) {
      out.push({ relPath: relative(root, absPath), absPath });
    }
  }
  return out;
}

export function read(sf: SourceFile): string {
  return readFileSync(sf.absPath, "utf-8");
}
