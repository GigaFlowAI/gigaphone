# GigaPhone

**Trace-coverage instrumentation for AI agent codebases — neutral across harness,
language, vendor, and codebase.**

GigaPhone runs over a customer's codebase and guarantees that AI agent **tool
executions** — especially code-execution tools — are logged to the customer's
observability platform as properly nested spans with complete inputs and outputs.
If a tool's output never lands in the trace, an eval platform cannot see or score
it. Those outputs are frequently lost during onboarding, which blocks activation.
GigaPhone detects the gaps, remediates them with reviewable idempotent edits, and
verifies the result against the live project.

> The naive version of this tool adds a tracing decorator wherever one is missing.
> That is wrong. The real problem is rarely "no decorator" — it is that the tool
> result is produced *outside* the agent's span context, or logged in a *lossy*
> shape, so it disappears or lands in a detached trace. GigaPhone is a
> span-coverage **diagnostic and remediation** tool, and that diagnosis is identical
> across every harness, language, vendor, and codebase.

## The four axes of neutrality

| Axis | What varies | How it plugs in |
|------|-------------|-----------------|
| **Harness** | how GigaPhone is driven & packaged (Claude Code, Codex; later Hermes, Cursor, Gemini) | harness adapter (`adapters/harness/`) |
| **Language** | the codebase's language (Python, TypeScript in v1) | language pack (`packs/`) |
| **Vendor** | where spans are emitted & verified (Braintrust, LangSmith, Arize, Logfire, any OTLP) | backend adapter (`adapters/backend/`) |
| **Codebase** | the shape of *this* customer's code, esp. the LLM gateway | discovered **config**, not code (`gigaphone.boundaries.yaml`) |

The first three are pluggable **code** interfaces; the fourth is externalized **data**
learned by discovery. The engine carries zero built-in assumptions about a specific
harness, language, vendor, or codebase — each lives behind an interface or in config.
Axes compose freely (e.g. Codex × TypeScript × LangSmith × Acme's gateway).

## Core thesis

For an agent to act on a tool result, that result must return into the agent's
process and be handed to the model. There is always an **in-process consumption
boundary** that feeds execution output back to the agent, running on the normal
call stack inside the agent's span context. That seam is the correct and sufficient
place to instrument — regardless of how the sandbox runs the code (subprocess,
Docker, E2B, remote worker). Discovery finds that seam without hardcoding anything.
See [ADR-0003](docs/adr/0003-trace-the-consumption-boundary.md).

## CLI

```
gigaphone discover   # scan (optionally scoped) → propose boundary descriptors to confirm
gigaphone detect     # run language-pack queries for confirmed anchors → candidate boundaries
gigaphone plan       # plan records (+ unresolved[] list)
gigaphone resolve    # ingest an agent-supplied resolution for an unresolved boundary
gigaphone fix        # apply codemods via backend adapter + language pack; emit diffs
gigaphone verify     # backend-adapter verify against the live project
```

## Failure-mode taxonomy

Properties of the customer's code, invariant on all four axes; only the fix primitive differs.

| Mode | What's happening | Fix |
|------|------------------|-----|
| `no_boundary` | exec calls inlined / scattered; no single consumption layer | introduce/consolidate, then trace |
| `untraced` | boundary exists, no span | `trace_boundary(...)`, type = tool |
| `off_context` | traced but off the agent's context (pool/executor/queue) → orphan trace | `restore_context(...)` |
| `lossy_output` | traced but logs only the truncated model-facing string | `map_output(...)` from complete-result fields |

## Status

**v1 — working end-to-end.** The full pipeline runs over a real agent codebase:
discover → classify → fix → verify. Try it on the bundled testclient:

```bash
TMP=$(mktemp -d); cp -r testclient/app "$TMP/app"
gigaphone onboard --repo "$TMP" --scope app --module app.run_representative
# Harness: cli · Language: python · Backend: otel
# 3 tools · 1 untraced · 1 off-context · 1 lossy
# Fixed + verified 3/3 tool spans (nested + complete).
```

### Install as a Claude Code plugin

The repo root is itself a Claude Code plugin **and** a single-plugin marketplace
(validated with `claude plugin validate . --strict`; installs with status ✔ enabled —
skill + post-edit hook + MCP server).

```
claude plugin marketplace add GigaFlow-AI-Incorporated/gigaphone
claude plugin install gigaphone@gigaphone
```

**No dependencies.** The engine is pure stdlib, so the plugin launches a bare `python3`
(3.9+ — e.g. the system interpreter) against the cloned source; there is **no pip / uv /
venv install step**. Installing the plugin wires the MCP verifier (`gigaphone` tools:
discover / plan / fix / verify), the shared `SKILL.md` (which walks you through the
onboarding flow and runs the engine on demand), and a `PostToolUse` hook that re-checks
coverage as you edit. **Codex**: point it at the repo — the skill is at
`.agents/skills/gigaphone/`; the package manifest is `adapters/harness/codex/`. Both
manifests are generated from one source (`src/gigaphone/adapters/harness/manifest.py`) by
`scripts/build_plugins.py`.

What's implemented:

- **Engine**: discovery → committed config, deterministic localization, the four fixes
  (`trace_boundary` / `restore_context` / `map_output`, plus advisory `no_boundary`),
  idempotent diffs, real verification, resolution protocol, drift detection, head-less CI.
- **Language axis**: Python pack (full, stdlib `ast` per [ADR-0007](docs/adr/0007-python-pack-uses-stdlib-ast.md));
  TypeScript pack (lexical v1).
- **Vendor axis**: generic OTel (full + e2e-verified via in-process span capture);
  Braintrust + LangSmith native adapters (contextvars family).
- **Harness axis**: Claude Code + Codex adapters generated from one manifest source; MCP
  verifier server (`gigaphone.mcp.server`).
- **Codebase axis**: discovered `gigaphone.boundaries.yaml`.

**e2e-verified path:** Python × OTel × the testclient (the hand-rolled gateway is
discovered; all three failure modes are reproduced, fixed, and confirmed nested + complete
by running the app). The TS pack and native backends are unit-tested but not yet behind a
live e2e. Roadmap: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). Full
design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Repository layout

```
AGENTS.md                          thin pointer file (routing + commands + prohibitions)
docs/DESIGN.md                     full design spec (v0.4)
docs/IMPLEMENTATION_PLAN.md        milestone record (v1 shipped)
docs/adr/                          architecture decision records (immutable)
docs/golden-principles.md          mechanical rules enforced on every change
.agents/skills/gigaphone/          shared SKILL.md body (discovery + resolution protocols)
src/gigaphone/
  cli.py · config.py               CLI engine + boundary-config I/O
  core/                            neutral model: boundary/plan-record/classifier types
  interfaces/                      the 3 pluggable code axes (language/backend/harness)
  engine/                          discover · detect · plan · resolve · fix · verify · report
  packs/{python,typescript}/       language packs
  adapters/backend/{otel,braintrust,langsmith}/   backend adapters
  adapters/harness/{claude_code,codex}/           harness adapters (one manifest source)
  runtime/                         fix-time shims imported by patched code
  mcp/server.py                    MCP verifier server
testclient/                        onboarding e2e fixture (hand-rolled gateway + 3 tools)
progress.json                      cross-session state
```
