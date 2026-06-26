"""Harness axis + MCP substrate (DESIGN §6).

Both harness manifests must derive from one source (no drift), and the MCP server must
drive the engine end-to-end — including the verify that proves spans land nested + complete.
"""

from __future__ import annotations

import json
import os
import shutil

import pytest

from gigaphone.adapters.harness.claude_code import ClaudeCodeAdapter
from gigaphone.adapters.harness.codex import CodexAdapter
from gigaphone.adapters.harness.manifest import PLUGIN, render_claude_code, render_codex
from gigaphone.mcp import server

_TESTCLIENT = os.path.join(os.path.dirname(__file__), "..", "testclient", "app")


def test_both_manifests_come_from_one_source():
    cc = render_claude_code()
    cx = render_codex()
    # same identity + MCP server + hook command, rendered into each harness's format
    assert cc["plugin.json"]["name"] == cx["plugin.toml"]["name"] == PLUGIN["name"]
    assert (
        cc[".mcp.json"]["mcpServers"]["gigaphone"]
        == cx["plugin.toml"]["mcp_servers"]["gigaphone"]
        == PLUGIN["mcp_server"]
    )
    cc_cmd = cc["hooks.json"]["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
    cx_cmd = cx["hooks"][0]["run"]
    assert cc_cmd == cx_cmd == PLUGIN["hook_command"]


def test_claude_plugin_uses_autoloaded_conventions():
    # plugin.json declares only identity; skills/, hooks/hooks.json, .mcp.json auto-load.
    # Declaring them in plugin.json too is a duplicate that fails to load (caught at install).
    pj = render_claude_code()["plugin.json"]
    assert "hooks" not in pj and "skills" not in pj and "mcpServers" not in pj
    # the engine launches as a bare python3 with PYTHONPATH at the cloned source — zero
    # third-party deps, no pip/uv/venv
    mcp = PLUGIN["mcp_server"]
    assert mcp["command"] == "python3"
    assert mcp["args"] == ["-m", "gigaphone.mcp.server"]
    assert mcp["env"]["PYTHONPATH"] == "${CLAUDE_PLUGIN_ROOT}/src"


def test_codex_runs_command_only_hooks():
    cx = render_codex()
    # Codex hooks are plain shell commands (no event-object form)
    assert set(cx["hooks"][0]) == {"on", "run"}
    assert "openai.yaml" in cx


def test_adapters_implement_the_interface_and_decline_to_drive():
    for adapter in (ClaudeCodeAdapter(), CodexAdapter()):
        assert adapter.skill_frontmatter()["name"] == "gigaphone"
        assert adapter.package()  # renders a manifest
        with pytest.raises(NotImplementedError):
            adapter.drive("any task")  # the engine never calls a model (ADR-0006)


def test_committed_plugin_files_match_the_single_source():
    """The committed Claude Code plugin must equal `scripts/build_plugins.py` output, and
    the bundled skill must match the canonical body — run the build script if this fails."""
    root = os.path.join(os.path.dirname(__file__), "..")
    cc = render_claude_code()

    def _load(rel):
        with open(os.path.join(root, rel), encoding="utf-8") as fh:
            return json.load(fh)

    assert _load(".claude-plugin/plugin.json") == cc["plugin.json"]
    assert _load(".claude-plugin/marketplace.json") == cc["marketplace.json"]
    assert _load(".mcp.json") == cc[".mcp.json"]
    assert _load("hooks/hooks.json") == cc["hooks.json"]

    with open(os.path.join(root, "skills/gigaphone/SKILL.md"), encoding="utf-8") as fh:
        bundled = fh.read()
    with open(os.path.join(root, ".agents/skills/gigaphone/SKILL.md"), encoding="utf-8") as fh:
        canonical = fh.read()
    assert bundled == canonical  # no drift between Codex + Claude Code skill copies


def test_mcp_exposes_engine_verbs():
    names = {t["name"] for t in server.list_tools()}
    assert {"discover", "plan", "fix", "verify"} <= names


def test_mcp_drives_full_onboarding_end_to_end(tmp_path):
    shutil.copytree(_TESTCLIENT, tmp_path / "app")
    repo = str(tmp_path)

    discovered = server.call_tool("discover", {"repo": repo, "scope": "app"})
    assert any(d["kind"] == "llm" for d in discovered["descriptors"])

    plan = server.call_tool("plan", {"repo": repo, "scope": "app"})
    modes = {m for r in plan["records"] for m in r["failure_modes"]}
    assert {"untraced", "off_context", "lossy_output"} <= modes

    server.call_tool("fix", {"repo": repo, "scope": "app", "apply": True})

    verified = server.call_tool("verify", {"repo": repo, "module": "app.run_representative"})
    assert verified["results"] and all(r["ok"] for r in verified["results"])
