"""Generate the committed harness plugin files from the single manifest source.

Run: `uv run python scripts/build_plugins.py`. Writes the Claude Code plugin (the repo
root is the plugin + a single-plugin marketplace) and the Codex package, plus a bundled
copy of the shared SKILL.md so the Claude Code plugin is self-contained. A test asserts the
committed files match these renders and that the bundled skill matches the canonical body.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from gigaphone.adapters.harness.manifest import render_claude_code, render_codex  # noqa: E402

# The canonical shared skill body (Codex discovery path) — copied into the Claude plugin.
CANONICAL_SKILL = ROOT / ".agents" / "skills" / "gigaphone"
CLAUDE_SKILL = ROOT / "skills" / "gigaphone"


def _write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _toml(d: dict) -> str:
    return f'name = "{d["name"]}"\nversion = "{d["version"]}"\ndescription = "{d["description"]}"\n'


def _yaml(d: dict) -> str:
    i = d["interface"]
    return (
        "interface:\n"
        f'  display_name: "{i["display_name"]}"\n'
        f'  short_description: "{i["short_description"]}"\n'
        "policy:\n"
        f"  allow_implicit_invocation: {str(d['policy']['allow_implicit_invocation']).lower()}\n"
    )


def build() -> None:
    cc = render_claude_code()
    # Claude Code plugin = repo root.
    _write_json(ROOT / ".claude-plugin" / "plugin.json", cc["plugin.json"])
    _write_json(ROOT / ".claude-plugin" / "marketplace.json", cc["marketplace.json"])
    _write_json(ROOT / "hooks" / "hooks.json", cc["hooks.json"])
    (ROOT / ".mcp.json").unlink(missing_ok=True)  # no MCP server — the skill drives the CLI
    # Bundle the shared skill into the plugin (self-contained).
    if CLAUDE_SKILL.exists():
        shutil.rmtree(CLAUDE_SKILL)
    shutil.copytree(CANONICAL_SKILL, CLAUDE_SKILL)

    # Codex package (skill discovered from .agents/skills directly).
    cx = render_codex()
    codex = ROOT / "adapters" / "harness" / "codex"
    codex.mkdir(parents=True, exist_ok=True)
    (codex / "plugin.toml").write_text(_toml(cx["plugin.toml"]), encoding="utf-8")
    (codex / "openai.yaml").write_text(_yaml(cx["openai.yaml"]), encoding="utf-8")
    _write_json(codex / "hooks.json", {"hooks": cx["hooks"]})

    print("built: .claude-plugin/, hooks/, skills/gigaphone/, adapters/harness/codex/")


if __name__ == "__main__":
    build()
