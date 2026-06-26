# ADR-0009: Bidirectional harness review of discovery

- Status: Accepted
- Date: 2026-06-26

## Context

Deterministic AST discovery is high-precision but low-recall: it cannot see dispatches built
through factories / generic builders / cross-module indirection, and some heuristics over-fire.
Pure-structural matching cannot achieve both recall and precision on real heterogeneous code.

## Decision

Pair the deterministic proposer with a bidirectional harness review (`gigaphone review`): the
harness (the reasoning engine, ADR-0006) audits the proposal — REJECT false positives, ADD
missed boundaries — and the result is written to the committed `gigaphone.boundaries.yaml`.
Precision comes from the AST; recall + precision-audit come from the model.

## Consequences

- Determinism is preserved: the model is in the loop only at authoring/change time; CI replays
  the committed config (ADR-0004). The committed config carries the audit outcome as data.
- It generalizes beyond `agent_call` — the same review prunes pre-existing tool/LLM false
  positives.
- Review quality depends on the SKILL.md instructions being harness-agnostic; the
  implementation-blind onboarding gate tests exactly that.
