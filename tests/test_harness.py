"""Harness axis (DESIGN §6).

Both harness manifests derive from one source (no drift) and declare only identity, so the
standard component dirs auto-load. The plugin ships no MCP server — the skill drives the
engine via the CLI — so the post-edit hook runs a bare `python3`.
"""

from __future__ import annotations

import json
import os
import re

import pytest

from gigaphone.adapters.harness.claude_code import ClaudeCodeAdapter
from gigaphone.adapters.harness.codex import CodexAdapter
from gigaphone.adapters.harness.manifest import PLUGIN, render_claude_code, render_codex

_REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")


def _pyproject_version(root: str) -> str:
    with open(os.path.join(root, "pyproject.toml"), encoding="utf-8") as fh:
        return re.search(r'(?m)^version\s*=\s*"([^"]+)"', fh.read()).group(1)


def test_both_manifests_come_from_one_source():
    cc = render_claude_code()
    cx = render_codex()
    assert cc["plugin.json"]["name"] == cx["plugin.toml"]["name"] == PLUGIN["name"]
    cc_cmd = cc["hooks.json"]["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
    cx_cmd = cx["hooks"][0]["run"]
    assert cc_cmd == cx_cmd == PLUGIN["hook_command"]


def test_plugin_ships_no_mcp_server_and_uses_autoloaded_conventions():
    cc = render_claude_code()
    pj = cc["plugin.json"]
    # identity only — skills/, hooks/hooks.json auto-load; declaring them is a duplicate
    assert set(pj) == {"name", "version", "description", "author"}
    assert "mcpServers" not in pj
    # no MCP server is rendered at all (it was removed — the skill drives the CLI)
    assert ".mcp.json" not in cc
    assert "mcp_servers" not in render_codex()["plugin.toml"]
    assert "mcp_server" not in PLUGIN
    # the post-edit hook launches a bare python3 against the cloned source
    assert PLUGIN["hook_command"].startswith('PYTHONPATH="${CLAUDE_PLUGIN_ROOT}/src" python3 -m')


def test_codex_runs_command_only_hooks():
    cx = render_codex()
    assert set(cx["hooks"][0]) == {"on", "run"}
    assert "openai.yaml" in cx


def test_adapters_implement_the_interface_and_decline_to_drive():
    for adapter in (ClaudeCodeAdapter(), CodexAdapter()):
        assert adapter.skill_frontmatter()["name"] == "gigaphone"
        assert adapter.package()  # renders a manifest
        assert adapter.register_mcp() is None  # no MCP server shipped
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
    assert _load("hooks/hooks.json") == cc["hooks.json"]
    # no stray MCP config left in the tree
    assert not os.path.exists(os.path.join(root, ".mcp.json"))

    with open(os.path.join(root, "skills/gigaphone/SKILL.md"), encoding="utf-8") as fh:
        bundled = fh.read()
    with open(os.path.join(root, ".agents/skills/gigaphone/SKILL.md"), encoding="utf-8") as fh:
        canonical = fh.read()
    assert bundled == canonical  # no drift between Codex + Claude Code skill copies


def test_plugin_version_is_single_sourced_from_the_package():
    """The plugin version must be derived from the package version, not a hand-kept literal,
    so a bump in pyproject.toml can never drift from the shipped manifests."""
    from gigaphone.adapters.harness.manifest import resolve_version

    assert resolve_version() == _pyproject_version(_REPO_ROOT)
    assert PLUGIN["version"] == resolve_version()
    assert render_claude_code()["plugin.json"]["version"] == resolve_version()
    assert render_codex()["plugin.toml"]["version"] == resolve_version()


def test_rendered_artifacts_cover_both_harness_packages():
    from gigaphone.adapters.harness.packaging import rendered_artifacts

    arts = rendered_artifacts()
    assert ".claude-plugin/plugin.json" in arts
    assert ".claude-plugin/marketplace.json" in arts
    assert "hooks/hooks.json" in arts
    assert "adapters/harness/codex/plugin.toml" in arts
    assert "adapters/harness/codex/openai.yaml" in arts
    assert "adapters/harness/codex/hooks.json" in arts


def test_check_committed_plugins_passes_on_the_committed_tree():
    from gigaphone.adapters.harness.packaging import check_committed

    assert check_committed(_REPO_ROOT) == []


def test_check_artifacts_flags_a_stale_or_missing_file(tmp_path):
    from gigaphone.adapters.harness.packaging import check_artifacts, rendered_artifacts

    arts = rendered_artifacts()
    for rel, content in arts.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    assert check_artifacts(str(tmp_path)) == []  # freshly materialized → clean

    first = next(iter(arts))
    (tmp_path / first).write_text("CORRUPT", encoding="utf-8")
    assert first in check_artifacts(str(tmp_path))  # a drifted file is reported

    second = list(arts)[1]
    (tmp_path / second).unlink()
    assert second in check_artifacts(str(tmp_path))  # a missing file is reported
