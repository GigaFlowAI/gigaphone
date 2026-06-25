# AGENTS.md

Trace-coverage instrumentation for AI agent codebases. Neutral across **harness**,
**language**, **vendor**, and **codebase**. See `docs/DESIGN.md` for the why.

This file is a **pointer**, not documentation. Code and tests are the source of truth.

## Routing

- Architecture & theses → `docs/adr/` (immutable, numbered ADRs)
- Mechanical rules every change must hold → `docs/golden-principles.md`
- v1 scope & sequencing → `docs/IMPLEMENTATION_PLAN.md`
- Cross-session state → `progress.json` (structured; update at session end)
- The shared agent protocol body → `.agents/skills/gigaphone/SKILL.md`

## Commands

```
uv sync                  # install (Python 3.11+)
uv run gigaphone --help  # CLI: discover · detect · plan · resolve · fix · verify
uv run ruff check .      # lint (deterministic — must pass)
uv run ruff format .     # format
uv run pytest            # tests
```

## Prohibitions

- Do **not** edit linter/config files to silence errors (`pyproject.toml [tool.ruff]`).
- Do **not** hardcode a customer's gateway/code shape into the engine — it lives in
  `gigaphone.boundaries.yaml` (discovered config). See ADR-0004.
- Do **not** embed model calls in the engine — the harness is the reasoning engine. ADR-0002.
- Do **not** add a built-in assumption about a specific harness, language, or vendor —
  it goes behind an interface (`src/gigaphone/interfaces/`). ADR-0002.
- The engine never declares a tool "covered" without a backend `verify()`. ADR-0005.

## Working agreement

Plan → execute one task → verify with tests before declaring done. Keep `AGENTS.md`
and ADRs current when a rule or boundary changes; broken pointers fail loudly,
stale prose rots silently.
