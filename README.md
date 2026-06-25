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

**Draft v0.4 — scaffold.** This repository is the harness-engineered skeleton; v1
implementation is sequenced in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).
Full design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Repository layout

```
AGENTS.md                     thin pointer file for agents (routing + commands + prohibitions)
docs/DESIGN.md                full design spec (v0.4)
docs/IMPLEMENTATION_PLAN.md   v1 phasing
docs/adr/                     architecture decision records (immutable)
docs/golden-principles.md     mechanical rules enforced on every change
.agents/skills/gigaphone/     shared SKILL.md body (discovery + resolution protocols)
src/gigaphone/                neutral core: CLI, classifier, plan records, interfaces
packs/{python,typescript}/    language packs (grammar + queries + def-use + emitters)
adapters/backend/             backend adapters (otel, braintrust, langsmith)
adapters/harness/             harness wrappers (claude_code, codex)
progress.json                 cross-session state
```
