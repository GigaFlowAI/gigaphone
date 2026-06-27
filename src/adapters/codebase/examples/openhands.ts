/**
 * Bundled example CodebaseAdapter: OpenHands (OSS) — the reference for how an authored adapter
 * recognizes a dispatch the generic matcher can miss (ADR-0010).
 *
 * OpenHands dispatches a sub-agent by building a conversation request and POSTing it to the
 * agent server. When that request is assembled through factories/indirection, generic
 * dotted-call matching may not see it — but a codebase author knows the shape: a function that
 * references the OpenHands SDK and posts to a `/conversations` endpoint is the dispatch
 * boundary. This emits the neutral `agent_call` Descriptor; the pipeline does the rest.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BoundaryKind } from "../../../core/boundary.js";
import { Descriptor } from "../../../core/model.js";
import { CodebaseAdapter } from "../../../interfaces/codebaseAdapter.js";

const CONV_POST = /\([^)]*?['"][^'"]*\/conversations[^'"]*['"]/;

export class OpenHandsAdapter extends CodebaseAdapter {
  readonly id = "openhands";

  detect(repo: string): boolean {
    return scanFiles(repo, (t) => t.includes("openhands"));
  }

  override discover(path: string, source: string): Descriptor[] {
    if (!source.includes("openhands") || !CONV_POST.test(source)) return [];
    const fn = enclosingFunctionName(source);
    if (fn === null) return [];
    const module = moduleName(path);
    return [
      new Descriptor({
        id: `openhands-${fn}`,
        kind: BoundaryKind.AGENT_CALL,
        matchCall: `${module}.${fn}`,
        emitName: `${projectName(module)}.subagent.openhands`,
        outputPaths: ["events", "final_message"],
      }),
    ];
  }
}

function scanFiles(root: string, pred: (text: string) => boolean): boolean {
  const SKIP = new Set([".git", ".venv", "venv", "node_modules", "__pycache__"]);
  const stack = [root];
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
        if (!SKIP.has(e.name)) stack.push(p);
      } else if (e.name.endsWith(".py") || e.name.endsWith(".ts")) {
        try {
          if (pred(readFileSync(p, "utf-8"))) return true;
        } catch {
          // ignore unreadable
        }
      }
    }
  }
  return false;
}

/** First `def`/method whose body contains the conversations-POST (best-effort, lexical). */
function enclosingFunctionName(source: string): string | null {
  let current: string | null = null;
  for (const line of source.split("\n")) {
    const m = /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) current = m[1]!;
    if (CONV_POST.test(line) && current) return current;
  }
  return current;
}

function moduleName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  parts[parts.length - 1] = parts[parts.length - 1]!.replace(/\.(py|ts|tsx)$/, "");
  const start = Math.max(parts.indexOf("app"), parts.indexOf("src"));
  const kept = (start >= 0 ? parts.slice(start) : parts).filter((p) => p && p !== "index");
  if (kept[0] === "src") kept.shift();
  return kept.join(".");
}

function projectName(module: string): string {
  return module.split(".")[0] || "app";
}
