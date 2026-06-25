"""HarnessAdapter interface — the *harness* axis (DESIGN §6, ADR-0002).

The entire harness-specific surface; everything else — the ``SKILL.md`` body, MCP server,
language packs, codemods, specs, plan records — is shared. The divergent bits are the
manifest and hooks. Keep hooks to plain shell commands (Codex runs command hooks only)
and generate every manifest from one source.

v1 ships ``claude_code`` + ``codex`` (under ``adapters/harness/``).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class HarnessAdapter(ABC):
    """One concrete subclass per harness (Claude Code, Codex; later Hermes/Cursor/Gemini)."""

    id: str  # "claude-code" | "codex" | ...

    @abstractmethod
    def package(self, core: Any) -> Any:
        """Produce the install artifact for this harness (plugin manifest / marketplace entry)."""

    @abstractmethod
    def skill_frontmatter(self) -> dict[str, Any]:
        """Harness-specific SKILL.md frontmatter. The body is shared across harnesses."""

    @abstractmethod
    def register_mcp(self, server: Any) -> Any:
        """Wire the shared MCP verifier into this harness."""

    @abstractmethod
    def hook(self, event: str, command: str) -> Any:
        """Render a post-edit / verify hook in this harness's format (plain shell command)."""

    @abstractmethod
    def drive(self, task: Any) -> Any:
        """Invoke the harness's own model to fulfil the discovery/resolution protocols.
        The engine itself never calls a model (ADR-0006)."""

    @abstractmethod
    def present_diff(self, diff: Any) -> Any:
        """Surface proposed edits via the harness's approval/diff UX."""
