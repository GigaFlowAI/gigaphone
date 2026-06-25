# ADR-0001: Record architecture decisions

- Status: Accepted
- Date: 2026-06-25

## Context

Per harness-engineering practice, the codebase must stay legible to future agent
runs. Prose documentation rots silently; tests and immutable records do not. We need
a durable place for *why* decisions, separate from the *what* in `DESIGN.md` and the
*how* in code.

## Decision

We keep Architecture Decision Records in `docs/adr/`, numbered and append-only. An ADR
is never edited to change its decision — it is **Superseded** by a later ADR and its
status marker updated. Status is one of: Proposed · Accepted · Superseded.

Each ADR is short: context, decision, consequences. `AGENTS.md` routes to ADRs rather
than restating them, so there is one source of truth and broken pointers fail loudly.

## Consequences

- New agents/contributors learn the binding constraints by reading numbered ADRs.
- Decisions resist rot through immutability + status markers.
- Reversing a decision means writing a new ADR, not quietly editing an old one.
