"""Render + verify the committed harness plugin artifacts (DESIGN §6, §13).

The repo root *is* the Claude Code plugin and a single-plugin marketplace; ``adapters/
harness/codex/`` is the Codex package. Both are generated from the single ``manifest``
source. This module owns the exact on-disk serialization (so ``scripts/build_plugins.py``
is a thin CLI over it) and a freshness check used by the build's ``--check`` mode and CI —
the release gate that catches a manifest edit that wasn't rebuilt + committed.

``rendered_artifacts()`` returns the file-content map with no filesystem dependency, so the
check and the tests compare bytes deterministically. The skill bundle (a directory copy) is
verified separately by ``check_committed``.
"""

from __future__ import annotations

import json
from pathlib import Path

from gigaphone.adapters.harness.manifest import render_claude_code, render_codex

# Repo-relative locations of the generated files + the skill bundle source/dest.
_CLAUDE_PLUGIN = ".claude-plugin"
_CODEX = "adapters/harness/codex"
_CANONICAL_SKILL = ".agents/skills/gigaphone"  # Codex discovery path (source of truth)
_BUNDLED_SKILL = "skills/gigaphone"  # copied into the Claude Code plugin
_MCP_CONFIG = ".mcp.json"  # must NOT exist — the skill drives the CLI, no MCP server


def _json_text(obj: dict) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def _toml_text(d: dict) -> str:
    return f'name = "{d["name"]}"\nversion = "{d["version"]}"\ndescription = "{d["description"]}"\n'


def _yaml_text(d: dict) -> str:
    i = d["interface"]
    return (
        "interface:\n"
        f'  display_name: "{i["display_name"]}"\n'
        f'  short_description: "{i["short_description"]}"\n'
        "policy:\n"
        f"  allow_implicit_invocation: {str(d['policy']['allow_implicit_invocation']).lower()}\n"
    )


def rendered_artifacts() -> dict[str, str]:
    """Map of repo-relative path -> exact committed file content, for both harness packages.

    Pure (no filesystem reads), so callers can write it, diff it, or assert on it. The skill
    bundle is a directory copy and is handled by ``write`` / ``check_committed`` separately.
    """
    cc = render_claude_code()
    cx = render_codex()
    return {
        f"{_CLAUDE_PLUGIN}/plugin.json": _json_text(cc["plugin.json"]),
        f"{_CLAUDE_PLUGIN}/marketplace.json": _json_text(cc["marketplace.json"]),
        "hooks/hooks.json": _json_text(cc["hooks.json"]),
        f"{_CODEX}/plugin.toml": _toml_text(cx["plugin.toml"]),
        f"{_CODEX}/openai.yaml": _yaml_text(cx["openai.yaml"]),
        f"{_CODEX}/hooks.json": _json_text({"hooks": cx["hooks"]}),
    }


def check_artifacts(root: str, artifacts: dict[str, str] | None = None) -> list[str]:
    """Return the repo-relative paths whose on-disk content is missing or differs from the
    rendered artifact (sorted). Empty list ⇒ every generated file is fresh."""
    artifacts = rendered_artifacts() if artifacts is None else artifacts
    root_path = Path(root)
    stale: list[str] = []
    for rel, content in artifacts.items():
        path = root_path / rel
        try:
            current = path.read_text(encoding="utf-8")
        except OSError:
            stale.append(rel)
            continue
        if current != content:
            stale.append(rel)
    return sorted(stale)


def check_committed(root: str) -> list[str]:
    """Full freshness check: rendered artifacts + the bundled-skill copy match the canonical
    body + no stray ``.mcp.json``. Returns the list of offending repo-relative paths."""
    offenders = check_artifacts(root)
    root_path = Path(root)

    canonical = root_path / _CANONICAL_SKILL / "SKILL.md"
    bundled = root_path / _BUNDLED_SKILL / "SKILL.md"
    try:
        drifted = bundled.read_text(encoding="utf-8") != canonical.read_text(encoding="utf-8")
    except OSError:
        drifted = True
    if drifted:
        offenders.append(f"{_BUNDLED_SKILL}/SKILL.md")

    if (root_path / _MCP_CONFIG).exists():
        offenders.append(_MCP_CONFIG)
    return sorted(offenders)


def write(root: str) -> list[str]:
    """Write every generated artifact, bundle the canonical skill into the Claude Code
    plugin, and remove any stray ``.mcp.json``. Returns the repo-relative paths written."""
    import shutil

    root_path = Path(root)
    artifacts = rendered_artifacts()
    for rel, content in artifacts.items():
        path = root_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    (root_path / _MCP_CONFIG).unlink(missing_ok=True)

    src = root_path / _CANONICAL_SKILL
    dest = root_path / _BUNDLED_SKILL
    if src.exists():
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
    return sorted(artifacts)
