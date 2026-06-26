"""Claude Code harness adapter (DESIGN §6).

Only the harness-specific surface lives here: packaging (plugin manifest + marketplace),
skill frontmatter, MCP wiring, event hooks, and diff presentation. The SKILL.md *body*,
MCP server, packs, and codemods are all shared. ``drive`` is intentionally not the
engine's job — the live harness fulfils the discovery/resolution protocols (ADR-0006).
"""

from __future__ import annotations

from typing import Any

from gigaphone.adapters.harness.manifest import PLUGIN, render_claude_code
from gigaphone.interfaces.harness_adapter import HarnessAdapter


class ClaudeCodeAdapter(HarnessAdapter):
    id = "claude-code"

    def package(self, core: Any = None) -> dict:
        return render_claude_code()

    def skill_frontmatter(self) -> dict[str, Any]:
        # Claude Code reads name + description; the body is the shared SKILL.md.
        return {"name": PLUGIN["name"], "description": PLUGIN["description"]}

    def register_mcp(self, server: Any = None) -> None:
        # The plugin ships no MCP server — the skill drives the engine via the CLI.
        return None

    def hook(self, event: str, command: str) -> dict:
        # hooks/hooks.json shape — the map is wrapped under a top-level "hooks" key.
        return {
            "hooks": {
                "PostToolUse": [
                    {"matcher": "Edit|Write", "hooks": [{"type": "command", "command": command}]}
                ]
            }
        }

    def drive(self, task: Any) -> Any:
        raise NotImplementedError(
            "The engine never calls a model. The live Claude Code harness drives its own "
            "model to fulfil the discovery/resolution protocols (see SKILL.md, ADR-0006)."
        )

    def present_diff(self, diff: Any) -> str:
        # Claude Code renders unified diffs natively in its approval UX.
        return str(diff)
