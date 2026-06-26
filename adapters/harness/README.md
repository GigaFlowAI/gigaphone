# Harness adapters (the *harness* axis)

The entire harness-specific surface: package + skill frontmatter + hooks + drive + present_diff. Everything else (SKILL.md
body, packs, codemods, plan
records) is shared. See `src/gigaphone/interfaces/harness_adapter.py` and DESIGN §6.

- `claude_code/` — v1. Plugin manifest + marketplace; event hooks. No MCP server (the skill drives the CLI).
- `codex/` — v1. Plugin + marketplace (+ `agents/openai.yaml`); command hooks only.

Keep hooks to plain shell commands and generate both manifests from one source.
