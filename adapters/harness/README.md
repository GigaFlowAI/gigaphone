# Harness adapters (the *harness* axis)

The entire harness-specific surface: package + skill frontmatter + MCP wiring + hooks +
drive + present_diff. Everything else (SKILL.md body, MCP server, packs, codemods, plan
records) is shared. See `src/gigaphone/interfaces/harness_adapter.py` and DESIGN §6.

- `claude_code/` — v1. Plugin manifest + marketplace; event hooks; MCP.
- `codex/` — v1. Plugin + marketplace (+ `agents/openai.yaml`); command hooks only; MCP.

Keep hooks to plain shell commands and generate both manifests from one source.
