# ADR-0004: Codebase shape is discovered config, not engine code

- Status: Accepted
- Date: 2026-06-25

## Context

A hand-rolled gateway like `our_llm.chat(...)` is invisible to built-in anchors, so
codebase-specific anchors must be *learned*. But GigaPhone edits production code and
runs head-less in CI, so the boundary set must be reproducible, reviewable, auditable,
and runnable without an agent. A live LLM scan on every run is none of those.

## Decision

LLM-assisted **discovery** produces a durable, committed boundary config
(`gigaphone.boundaries.yaml`); deterministic passes **consume** it. The LLM is in the
loop for discovery and change only — never for routine analysis.

- **Phase A (discovery)** — semantic, breadth-first, agent-led, cheap: read the gateway,
  understand the loop, propose boundary descriptors. User confirms.
- **Phase B (localization)** — syntactic, depth-first, deterministic: run language-pack
  queries for confirmed anchors, walk def-use, classify, emit byte-accurate plan records.

Three convergent ways to produce the one artifact: hand-write · point at gateway files
(`--scope`, the recommended default) · full-repo scan. Built-in anchors are a bundled
default pack in the same schema; project config overrides and is authoritative.

**Drift:** the committed config is checked each run; when anchors no longer resolve,
GigaPhone flags drift and re-triggers Phase A for just the affected area.

## Consequences

- Determinism, caching, a diff target for review, and head-less CI all follow from the
  config being the source of truth.
- The nondeterministic step (Phase A) happens once per change, not per run.
- Requires reliable drift detection, or configs silently rot and coverage regresses
  (DESIGN §16, tracked risk).
