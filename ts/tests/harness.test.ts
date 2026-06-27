/**
 * Harness axis (DESIGN §6).
 *
 * Both harness manifests derive from one source (no drift) and declare only identity, so the
 * standard component dirs auto-load. The plugin ships no MCP server — the skill drives the
 * engine via the CLI — so the post-edit hook runs a bare `python3`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/harness/claudeCode.js";
import { CodexAdapter } from "../src/adapters/harness/codex.js";
import {
  PLUGIN,
  renderClaudeCode,
  renderCodex,
  resolveVersion,
} from "../src/adapters/harness/manifest.js";
import {
  checkArtifacts,
  checkCommitted,
  renderedArtifacts,
} from "../src/adapters/harness/packaging.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/ -> ts/ -> repo root
const _REPO_ROOT = join(__dirname, "..", "..");

function pkgVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
    version: string;
  };
  return pkg.version;
}

it("both manifests come from one source", () => {
  const cc = renderClaudeCode();
  const cx = renderCodex();
  expect(cc["plugin.json"].name).toBe(PLUGIN.name);
  expect(cx["plugin.toml"].name).toBe(PLUGIN.name);
  const ccCmd = cc["hooks.json"].hooks.PostToolUse[0]!.hooks[0]!.command;
  const cxCmd = cx.hooks[0]!.run;
  expect(ccCmd).toBe(PLUGIN.hook_command);
  expect(cxCmd).toBe(PLUGIN.hook_command);
});

it("plugin ships no mcp server and uses auto-loaded conventions", () => {
  const cc = renderClaudeCode() as Record<string, unknown>;
  const pj = (cc as ReturnType<typeof renderClaudeCode>)["plugin.json"];
  // identity only — skills/, hooks/hooks.json auto-load; declaring them is a duplicate
  expect(new Set(Object.keys(pj))).toEqual(
    new Set(["name", "version", "description", "author"]),
  );
  expect("mcpServers" in pj).toBe(false);
  // no MCP server is rendered at all (it was removed — the skill drives the CLI)
  expect(".mcp.json" in cc).toBe(false);
  expect("mcp_servers" in renderCodex()["plugin.toml"]).toBe(false);
  expect("mcp_server" in PLUGIN).toBe(false);
  // the post-edit hook launches a bare python3 against the cloned source
  expect(
    PLUGIN.hook_command.startsWith(
      'PYTHONPATH="${CLAUDE_PLUGIN_ROOT}/src" python3 -m',
    ),
  ).toBe(true);
});

it("codex runs command-only hooks", () => {
  const cx = renderCodex();
  expect(new Set(Object.keys(cx.hooks[0]!))).toEqual(new Set(["on", "run"]));
  expect("openai.yaml" in cx).toBe(true);
});

it("adapters implement the interface and decline to drive", () => {
  for (const adapter of [new ClaudeCodeAdapter(), new CodexAdapter()]) {
    expect(adapter.skillFrontmatter().name).toBe("gigaphone");
    expect(adapter.package()).toBeTruthy(); // renders a manifest
    expect(adapter.registerMcp()).toBeNull(); // no MCP server shipped
    expect(() => adapter.drive("any task")).toThrow(); // engine never calls a model (ADR-0006)
  }
});

it("committed plugin files match the single source", () => {
  const cc = renderClaudeCode();

  const load = (rel: string) =>
    JSON.parse(readFileSync(join(_REPO_ROOT, rel), "utf-8"));

  expect(load(".claude-plugin/plugin.json")).toEqual(cc["plugin.json"]);
  expect(load(".claude-plugin/marketplace.json")).toEqual(cc["marketplace.json"]);
  expect(load("hooks/hooks.json")).toEqual(cc["hooks.json"]);
  // no stray MCP config left in the tree
  expect(existsSync(join(_REPO_ROOT, ".mcp.json"))).toBe(false);

  const bundled = readFileSync(
    join(_REPO_ROOT, "skills/gigaphone/SKILL.md"),
    "utf-8",
  );
  const canonical = readFileSync(
    join(_REPO_ROOT, ".agents/skills/gigaphone/SKILL.md"),
    "utf-8",
  );
  expect(bundled).toBe(canonical); // no drift between Codex + Claude Code skill copies
});

it("plugin version is single-sourced from the package", () => {
  expect(resolveVersion()).toBe(pkgVersion(join(_REPO_ROOT, "ts")));
  expect(PLUGIN.version).toBe(resolveVersion());
  expect(renderClaudeCode()["plugin.json"].version).toBe(resolveVersion());
  expect(renderCodex()["plugin.toml"].version).toBe(resolveVersion());
});

it("rendered artifacts cover both harness packages", () => {
  const arts = renderedArtifacts();
  expect(".claude-plugin/plugin.json" in arts).toBe(true);
  expect(".claude-plugin/marketplace.json" in arts).toBe(true);
  expect("hooks/hooks.json" in arts).toBe(true);
  expect("adapters/harness/codex/plugin.toml" in arts).toBe(true);
  expect("adapters/harness/codex/openai.yaml" in arts).toBe(true);
  expect("adapters/harness/codex/hooks.json" in arts).toBe(true);
});

it("check_committed passes on the committed tree", () => {
  expect(checkCommitted(_REPO_ROOT)).toEqual([]);
});

describe("check_artifacts flags a stale or missing file", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(__dirname, `.tmp-harness-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reports drifted and missing files", () => {
    const arts = renderedArtifacts();
    for (const [rel, content] of Object.entries(arts)) {
      const p = join(tmp, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, "utf-8");
    }
    expect(checkArtifacts(tmp)).toEqual([]); // freshly materialized → clean

    const keys = Object.keys(arts);
    const first = keys[0]!;
    writeFileSync(join(tmp, first), "CORRUPT", "utf-8");
    expect(checkArtifacts(tmp)).toContain(first); // a drifted file is reported

    const second = keys[1]!;
    rmSync(join(tmp, second));
    expect(checkArtifacts(tmp)).toContain(second); // a missing file is reported
  });
});
