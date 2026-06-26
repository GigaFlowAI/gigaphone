"""One source of truth for both harness manifests (DESIGN §6).

The divergent bits across harnesses are the manifest format and the hook format; the
SKILL.md body, language packs, codemods, and plan records are all shared. So we keep a
single ``PLUGIN`` spec and render it per harness.

The repo root is itself the Claude Code plugin **and** a single-plugin marketplace. The
engine is pure stdlib, so the plugin invokes a bare ``python3`` against the cloned source
(no pip/uv/venv). The skill drives the engine via that CLI on demand — the plugin ships **no
MCP server** (a stdio MCP process was tried and removed: it added a flaky always-on
connection for no benefit over invoking the CLI directly).

``scripts/build_plugins.py`` writes the committed plugin files from these renders.
"""

from __future__ import annotations

from typing import Any

NAME = "gigaphone"
VERSION = "0.5.0"
DESCRIPTION = (
    "Trace-coverage instrumentation for AI agent tool executions — "
    "neutral across harness, language, vendor, and codebase."
)

# The engine is pure stdlib (zero third-party deps), so the hook runs a bare `python3`
# (3.9+, e.g. Apple's system interpreter) against the cloned source — no pip/uv/venv.
# ${CLAUDE_PLUGIN_ROOT} is the plugin dir (= repo root); ${CLAUDE_PROJECT_DIR} is the
# user's project where the hook runs.
_PYTHONPATH = "${CLAUDE_PLUGIN_ROOT}/src"
_HOOK_COMMAND = (
    f'PYTHONPATH="{_PYTHONPATH}" python3 -m gigaphone.cli detect '
    '--repo "${CLAUDE_PROJECT_DIR}" || true'
)

# The single source. Adding a harness = a new render_* function, not a new copy of this.
PLUGIN: dict[str, Any] = {
    "name": NAME,
    "version": VERSION,
    "description": DESCRIPTION,
    "hook_command": _HOOK_COMMAND,
}


def render_claude_code() -> dict[str, Any]:
    """Claude Code: a repo-root plugin (`.claude-plugin/plugin.json`) that is also a
    single-plugin marketplace, with a bundled skill and a post-edit hook."""
    return {
        # plugin.json declares only identity. The standard component dirs (skills/,
        # hooks/hooks.json) auto-load — declaring them too is a duplicate.
        "plugin.json": {
            "name": NAME,
            "version": VERSION,
            "description": DESCRIPTION,
            "author": {"name": "Gigaflow"},
        },
        "marketplace.json": {
            "name": NAME,
            "owner": {"name": "Gigaflow"},
            "description": "GigaPhone — trace-coverage instrumentation for AI agent codebases.",
            "plugins": [{"name": NAME, "source": ".", "description": DESCRIPTION}],
        },
        # hooks/hooks.json wraps the hook map under a top-level "hooks" key.
        "hooks.json": {
            "hooks": {
                "PostToolUse": [
                    {
                        "matcher": "Edit|Write",
                        "hooks": [{"type": "command", "command": _HOOK_COMMAND}],
                    }
                ]
            }
        },
    }


def render_codex() -> dict[str, Any]:
    """Codex: a plugin manifest (+ agents/openai.yaml) + command-only hooks. Codex discovers
    the shared skill via the repo's `.agents/skills/gigaphone/` directly."""
    return {
        "plugin.toml": {"name": NAME, "version": VERSION, "description": DESCRIPTION},
        "openai.yaml": {
            "interface": {"display_name": "GigaPhone", "short_description": DESCRIPTION},
            "policy": {"allow_implicit_invocation": True},
        },
        # Codex runs command hooks only — the same plain shell command.
        "hooks": [{"on": "post-edit", "run": _HOOK_COMMAND}],
    }
