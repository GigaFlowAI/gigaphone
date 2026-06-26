"""Codex harness adapter (DESIGN §6).

Same shared substrate as Claude Code; the divergent bits are the plugin manifest format
(+ ``agents/openai.yaml``) and that Codex runs **command hooks only** — which is why the
hooks are plain shell commands in the single manifest source.
"""

from __future__ import annotations

from typing import Any

from gigaphone.adapters.harness.manifest import PLUGIN, render_codex
from gigaphone.interfaces.harness_adapter import HarnessAdapter


class CodexAdapter(HarnessAdapter):
    id = "codex"

    def package(self, core: Any = None) -> dict:
        return render_codex()

    def skill_frontmatter(self) -> dict[str, Any]:
        return {"name": PLUGIN["name"], "description": PLUGIN["description"]}

    def register_mcp(self, server: Any = None) -> None:
        # The plugin ships no MCP server — the skill drives the engine via the CLI.
        return None

    def hook(self, event: str, command: str) -> dict:
        # Codex command-only hook.
        return {"on": event, "run": command}

    def drive(self, task: Any) -> Any:
        raise NotImplementedError(
            "The engine never calls a model. The live Codex harness drives its own model "
            "to fulfil the discovery/resolution protocols (see SKILL.md, ADR-0006)."
        )

    def present_diff(self, diff: Any) -> str:
        return str(diff)
