/**
 * Bundled example CodebaseAdapter: Hermes (NousResearch's agent harness).
 *
 * Hermes does not scatter tracing calls; it exposes a *plugin hook bus*
 * (`hermes_cli.plugins` / `hermes_cli.hooks`) with named events, and its observability
 * plugins (e.g. langfuse) register on that bus. Generic dotted-call discovery cannot see this
 * architecture: it name-matches every function that happens to call a provider SDK (the main
 * gateway *and* every side-channel summary/title client) and every function that wraps an exec
 * sink (oauth helpers, shell-snippet preprocessors) — a precision disaster, while missing the
 * real tool seam entirely because tool dispatch goes through `registry.dispatch` /
 * `run_tool_execution_middleware` indirection (ADR-0010 is exactly this case).
 *
 * A codebase author knows hermes has precisely two consumption boundaries that matter — the
 * ones the langfuse plugin traces:
 *   1. tool_exec — `handle_function_call`: runs the tool via `registry.dispatch` and fires the
 *      `post_tool_call` hook (`_emit_post_tool_call_hook`) with the result. ADR-0003's seam.
 *   2. llm — the conversation gateway: the top-level function(s) that *forward a prepared
 *      request* to `chat.completions.create` — i.e. `create(**K)` where K originates from a
 *      parameter (directly, or as `{**param, ...}` / a copy). This dataflow signal selects the
 *      sync + streaming gateway paths (which receive the request and pass it through) and
 *      excludes side-channel clients (summaries, the iteration-limit path) that *assemble a new
 *      request from scratch*. It keys on hermes's call structure, never on a function name.
 *
 * Because this set is complete, the adapter is *authoritative* (CodebaseAdapter.authoritative):
 * generic packs are skipped so their noise never enters the config.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BoundaryKind } from "../../../core/boundary.js";
import { Descriptor } from "../../../core/model.js";
import { CodebaseAdapter } from "../../../interfaces/codebaseAdapter.js";

/** The hook-emitter that uniquely marks hermes's tool consumption boundary. */
const TOOL_HOOK_MARKER = "_emit_post_tool_call_hook";

export class HermesAdapter extends CodebaseAdapter {
  readonly id = "hermes";

  detect(repo: string): boolean {
    // `_emit_post_tool_call_hook` is hermes-specific; its presence identifies the harness.
    return scanFiles(repo, (t) => t.includes(TOOL_HOOK_MARKER));
  }

  /** Hermes's hook bus fully models its boundaries — own discovery, skip the generic packs. */
  override authoritative(): boolean {
    return true;
  }

  override discover(path: string, source: string): Descriptor[] {
    if (!path.endsWith(".py")) return [];
    const module = moduleName(path);
    const out: Descriptor[] = [];

    for (const fn of topLevelFunctions(source)) {
      // 1) tool consumption boundary: dispatches a tool AND fires the post_tool_call hook.
      if (
        fn.body.includes(TOOL_HOOK_MARKER) &&
        fn.body.includes("registry.dispatch") &&
        fn.name !== TOOL_HOOK_MARKER
      ) {
        out.push(
          new Descriptor({
            id: `hermes-tool-${fn.name}`,
            kind: BoundaryKind.TOOL_EXEC,
            matchCall: `${module}.${fn.name}`,
            inputArg: null,
            emitName: "hermes.tool",
          }),
        );
        continue;
      }
      // 2) LLM gateway: forwards a parameter-borne request to completions.create.
      const reqParam = forwardsRequestToCreate(fn);
      if (reqParam !== null) {
        out.push(
          new Descriptor({
            id: `hermes-llm-${fn.name}`,
            kind: BoundaryKind.LLM,
            matchCall: `${module}.${fn.name}`,
            inputArg: reqParam,
            emitName: "hermes.llm",
            provider: "openai",
          }),
        );
      }
    }
    return out;
  }
}

/**
 * Is `fn` a request-forwarding LLM gateway? Returns the originating request parameter name if
 * the function calls `*.completions.create(**K)` where K traces back to one of the function's
 * parameters — either K *is* a parameter, or K is a local built by spreading/copying a
 * parameter (`K = {**param, ...}`, `dict(param)`, `param.copy()`). Returns null otherwise.
 *
 * This is the dataflow that distinguishes the conversation gateway (which receives a prepared
 * request and passes it through) from side-channel callers that assemble a fresh request from
 * literal keys. Lexical, but the pattern is unambiguous in hermes's gateway code.
 */
function forwardsRequestToCreate(fn: TopLevelFn): string | null {
  const params = new Set(paramNames(fn.signature));
  const createRe = /\.completions\.create\(\s*\*\*([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = createRe.exec(fn.body)) !== null) {
    const k = m[1]!;
    if (params.has(k)) return k;
    const spread = new RegExp(`\\b${k}\\s*=\\s*\\{\\s*\\*\\*([A-Za-z_]\\w*)`).exec(fn.body);
    if (spread && params.has(spread[1]!)) return spread[1]!;
    const copy = new RegExp(`\\b${k}\\s*=\\s*(?:dict\\(\\s*([A-Za-z_]\\w*)|([A-Za-z_]\\w*)\\.copy\\()`).exec(
      fn.body,
    );
    if (copy) {
      const p = copy[1] ?? copy[2];
      if (p && params.has(p)) return p;
    }
  }
  return null;
}

/** Parameter identifiers from a `def NAME( ... )` header (best-effort; hermes params are simple). */
function paramNames(signature: string): string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close < 0 || close <= open) return [];
  return signature
    .slice(open + 1, close)
    .split(",")
    .map((s) => s.trim().replace(/^\*+/, "").split(/[:=\s]/)[0] ?? "")
    .filter((p) => p && p !== "self");
}

interface TopLevelFn {
  name: string;
  /** the `def NAME( ... )` header text, up to the colon that ends the signature */
  signature: string;
  /** the full source of the function (header + body), up to the next top-level statement */
  body: string;
}

/**
 * Split a Python module into its top-level `def`/`async def` blocks (col 0). Lexical, but
 * sufficient: a block runs from its `def` line to the next line that begins in column 0 and is
 * not a continuation/decorator/blank — capturing the multi-line signature and the whole body
 * (including nested defs). Adapters may not import the language packs (layering), so the
 * recognition here is deliberately self-contained.
 */
function topLevelFunctions(source: string): TopLevelFn[] {
  const lines = source.split("\n");
  const out: TopLevelFn[] = [];
  const defRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = defRe.exec(lines[i] ?? "");
    if (!m) continue;
    // extend to the end of this top-level block
    let end = i + 1;
    while (end < lines.length) {
      const line = lines[end] ?? "";
      // a new top-level statement (col-0, non-blank, not a continuation) closes the block
      if (line.length && !/^\s/.test(line) && !line.startsWith(")") && !line.startsWith("]")) {
        break;
      }
      end++;
    }
    const block = lines.slice(i, end);
    const blockText = block.join("\n");
    const colon = blockText.indexOf("):");
    const signature = colon >= 0 ? blockText.slice(0, colon + 1) : (lines[i] ?? "");
    out.push({ name: m[1]!, signature, body: blockText });
    i = end - 1;
  }
  return out;
}

/**
 * Module path mirroring the Python pack's `module_name`: drop `.py`, start at an `app`/`src`
 * package segment if present, drop `__init__`. Must match so Phase-B localization (which keys
 * on `module.funcName`) resolves these descriptors.
 */
function moduleName(path: string): string {
  let parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const last = parts.length - 1;
  parts[last] = parts[last]!.endsWith(".py") ? parts[last]!.slice(0, -3) : parts[last]!;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "app" || parts[i] === "src") {
      parts = parts.slice(i);
      break;
    }
  }
  if (parts[0] === "src") parts = parts.slice(1);
  return parts.filter((p) => p && p !== "__init__").join(".");
}

function scanFiles(root: string, pred: (text: string) => boolean): boolean {
  const SKIP = new Set([".git", ".venv", "venv", "node_modules", "__pycache__", ".claude"]);
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
      } else if (e.name.endsWith(".py")) {
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
