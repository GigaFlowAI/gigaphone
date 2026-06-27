/**
 * Render + verify the committed harness plugin artifacts (DESIGN §6, §13).
 *
 * The repo root *is* the Claude Code plugin and a single-plugin marketplace; `adapters/
 * harness/codex/` is the Codex package. Both are generated from the single `manifest`
 * source. This module owns the exact on-disk serialization and a freshness check used by the
 * build's `--check` mode and CI — the release gate that catches a manifest edit that wasn't
 * rebuilt + committed.
 *
 * `renderedArtifacts()` returns the file-content map with no filesystem dependency, so the
 * check and the tests compare bytes deterministically. The skill bundle (a directory copy) is
 * verified separately by `checkCommitted`.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ClaudeCodeRender,
  type CodexRender,
  renderClaudeCode,
  renderCodex,
} from "./manifest.js";

// Repo-relative locations of the generated files + the skill bundle source/dest.
const _CLAUDE_PLUGIN = ".claude-plugin";
const _CODEX = "adapters/harness/codex";
const _CANONICAL_SKILL = ".agents/skills/gigaphone"; // Codex discovery path (source of truth)
const _BUNDLED_SKILL = "skills/gigaphone"; // copied into the Claude Code plugin
const _MCP_CONFIG = ".mcp.json"; // must NOT exist — the skill drives the CLI, no MCP server

/** Match Python `json.dumps(obj, indent=2, ensure_ascii=False) + "\n"`. */
function jsonText(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function tomlText(d: CodexRender["plugin.toml"]): string {
  return `name = "${d.name}"\nversion = "${d.version}"\ndescription = "${d.description}"\n`;
}

function yamlText(d: CodexRender["openai.yaml"]): string {
  const i = d.interface;
  return (
    "interface:\n" +
    `  display_name: "${i.display_name}"\n` +
    `  short_description: "${i.short_description}"\n` +
    "policy:\n" +
    `  allow_implicit_invocation: ${String(d.policy.allow_implicit_invocation)}\n`
  );
}

/**
 * Map of repo-relative path -> exact committed file content, for both harness packages.
 *
 * Pure (no filesystem reads), so callers can write it, diff it, or assert on it. The skill
 * bundle is a directory copy and is handled by `write` / `checkCommitted` separately.
 */
export function renderedArtifacts(): Record<string, string> {
  const cc: ClaudeCodeRender = renderClaudeCode();
  const cx: CodexRender = renderCodex();
  return {
    [`${_CLAUDE_PLUGIN}/plugin.json`]: jsonText(cc["plugin.json"]),
    [`${_CLAUDE_PLUGIN}/marketplace.json`]: jsonText(cc["marketplace.json"]),
    "hooks/hooks.json": jsonText(cc["hooks.json"]),
    [`${_CODEX}/plugin.toml`]: tomlText(cx["plugin.toml"]),
    [`${_CODEX}/openai.yaml`]: yamlText(cx["openai.yaml"]),
    [`${_CODEX}/hooks.json`]: jsonText({ hooks: cx.hooks }),
  };
}

/**
 * Return the repo-relative paths whose on-disk content is missing or differs from the
 * rendered artifact (sorted). Empty list ⇒ every generated file is fresh.
 */
export function checkArtifacts(root: string, artifacts?: Record<string, string>): string[] {
  const arts = artifacts ?? renderedArtifacts();
  const stale: string[] = [];
  for (const [rel, content] of Object.entries(arts)) {
    const path = join(root, rel);
    let current: string;
    try {
      current = readFileSync(path, "utf-8");
    } catch {
      stale.push(rel);
      continue;
    }
    if (current !== content) stale.push(rel);
  }
  return stale.sort();
}

/**
 * Full freshness check: rendered artifacts + the bundled-skill copy match the canonical body
 * + no stray `.mcp.json`. Returns the list of offending repo-relative paths.
 */
export function checkCommitted(root: string): string[] {
  const offenders = checkArtifacts(root);

  const canonical = join(root, _CANONICAL_SKILL, "SKILL.md");
  const bundled = join(root, _BUNDLED_SKILL, "SKILL.md");
  let drifted: boolean;
  try {
    drifted = readFileSync(bundled, "utf-8") !== readFileSync(canonical, "utf-8");
  } catch {
    drifted = true;
  }
  if (drifted) offenders.push(`${_BUNDLED_SKILL}/SKILL.md`);

  if (existsSync(join(root, _MCP_CONFIG))) offenders.push(_MCP_CONFIG);
  return offenders.sort();
}

/**
 * Write every generated artifact, bundle the canonical skill into the Claude Code plugin, and
 * remove any stray `.mcp.json`. Returns the repo-relative paths written.
 */
export function write(root: string): string[] {
  const artifacts = renderedArtifacts();
  for (const [rel, content] of Object.entries(artifacts)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }

  rmSync(join(root, _MCP_CONFIG), { force: true });

  const src = join(root, _CANONICAL_SKILL);
  const dest = join(root, _BUNDLED_SKILL);
  if (existsSync(src)) {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
  }
  return Object.keys(artifacts).sort();
}
