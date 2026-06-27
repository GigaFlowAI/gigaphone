/**
 * One source of truth for both harness manifests (DESIGN §6).
 *
 * The divergent bits across harnesses are the manifest format and the hook format; the
 * SKILL.md body, language packs, codemods, and plan records are all shared. So we keep a
 * single `PLUGIN` spec and render it per harness.
 *
 * The repo root is itself the Claude Code plugin **and** a single-plugin marketplace. The
 * engine invokes a bare `python3` against the cloned source (no pip/uv/venv) for the runtime
 * hook the plugin ships. The skill drives the engine via that CLI on demand — the plugin
 * ships **no MCP server** (a stdio MCP process was tried and removed: it added a flaky
 * always-on connection for no benefit over invoking the CLI directly).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The single source of truth for the plugin version: the `version` field of the package's
 * `package.json` (mirrors the Python `resolve_version`, which read the installed package /
 * `pyproject.toml`). Keeps the shipped manifests from ever drifting from the package version.
 *
 * Resolves `package.json` relative to this module so it works from both `src/` (tests via
 * tsx) and `dist/` (compiled) — both put `package.json` three directories up.
 */
export function resolveVersion(): string {
  // src/adapters/harness/manifest.ts  ->  ../../../package.json  ==  ts/package.json
  const pkgPath = join(__dirname, "..", "..", "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const NAME = "gigaphone";
export const VERSION = resolveVersion();
export const DESCRIPTION =
  "Trace-coverage instrumentation for AI agent tool executions — " +
  "neutral across harness, language, vendor, and codebase.";

// The engine is pure stdlib (zero third-party deps), so the hook runs a bare `python3`
// (3.9+, e.g. Apple's system interpreter) against the cloned source — no pip/uv/venv.
// ${CLAUDE_PLUGIN_ROOT} is the plugin dir (= repo root); ${CLAUDE_PROJECT_DIR} is the
// user's project where the hook runs.
const _PYTHONPATH = "${CLAUDE_PLUGIN_ROOT}/src";
const _HOOK_COMMAND =
  `PYTHONPATH="${_PYTHONPATH}" python3 -m gigaphone.cli detect ` +
  '--repo "${CLAUDE_PROJECT_DIR}" || true';

export interface Plugin {
  name: string;
  version: string;
  description: string;
  hook_command: string;
}

// The single source. Adding a harness = a new render* function, not a new copy of this.
export const PLUGIN: Plugin = {
  name: NAME,
  version: VERSION,
  description: DESCRIPTION,
  hook_command: _HOOK_COMMAND,
};

export interface ClaudeCodeRender {
  "plugin.json": {
    name: string;
    version: string;
    description: string;
    author: { name: string };
  };
  "marketplace.json": {
    name: string;
    owner: { name: string };
    description: string;
    plugins: Array<{ name: string; source: string; description: string }>;
  };
  "hooks.json": {
    hooks: {
      PostToolUse: Array<{
        matcher: string;
        hooks: Array<{ type: string; command: string }>;
      }>;
    };
  };
}

export interface CodexRender {
  "plugin.toml": { name: string; version: string; description: string };
  "openai.yaml": {
    interface: { display_name: string; short_description: string };
    policy: { allow_implicit_invocation: boolean };
  };
  hooks: Array<{ on: string; run: string }>;
}

/**
 * Claude Code: a repo-root plugin (`.claude-plugin/plugin.json`) that is also a single-plugin
 * marketplace, with a bundled skill and a post-edit hook.
 */
export function renderClaudeCode(): ClaudeCodeRender {
  return {
    // plugin.json declares only identity. The standard component dirs (skills/,
    // hooks/hooks.json) auto-load — declaring them too is a duplicate.
    "plugin.json": {
      name: NAME,
      version: VERSION,
      description: DESCRIPTION,
      author: { name: "Gigaflow" },
    },
    "marketplace.json": {
      name: NAME,
      owner: { name: "Gigaflow" },
      description: "GigaPhone — trace-coverage instrumentation for AI agent codebases.",
      plugins: [{ name: NAME, source: ".", description: DESCRIPTION }],
    },
    // hooks/hooks.json wraps the hook map under a top-level "hooks" key.
    "hooks.json": {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: _HOOK_COMMAND }],
          },
        ],
      },
    },
  };
}

/**
 * Codex: a plugin manifest (+ agents/openai.yaml) + command-only hooks. Codex discovers the
 * shared skill via the repo's `.agents/skills/gigaphone/` directly.
 */
export function renderCodex(): CodexRender {
  return {
    "plugin.toml": { name: NAME, version: VERSION, description: DESCRIPTION },
    "openai.yaml": {
      interface: { display_name: "GigaPhone", short_description: DESCRIPTION },
      policy: { allow_implicit_invocation: true },
    },
    // Codex runs command hooks only — the same plain shell command.
    hooks: [{ on: "post-edit", run: _HOOK_COMMAND }],
  };
}
