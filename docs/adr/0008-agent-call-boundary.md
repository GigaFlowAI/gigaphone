# ADR-0008: The agent_call boundary — a sub-agent is a black box by ownership

- Status: Accepted
- Date: 2026-06-26

## Context

Harnesses that wrap a whole sub-agent (e.g. OpenHands → remote agent-server) hold no
in-process LLM call to anchor on, so bottom-up discovery finds nothing real.

## Decision

Add `BoundaryKind.AGENT_CALL`. Treat the sub-agent as a black box **by ownership** — the
repo owner is responsible only for their own dispatch boundary, not the sub-agent's
internals (the same rule that treats the sandbox as opaque, ADR-0003). Reuse the
untraced/lossy/off_context taxonomy and fix primitives; the only new surface is discovery,
via a data catalog of agent-SDK signatures (seed family B). Unknowns use the resolution
protocol (ADR-0006); confirmed signatures are contributed back as catalog entries.

## Consequences

- Context propagation *into* the sub-agent is out of scope (not the owner's responsibility,
  not verifiable as theirs). Cross-harness trees compose at the backend iff both export.
- `off_context` for an agent_call is scoped to the owner's own root trace.
- A new finite seed family (agent SDKs) sits beside LLM SDKs; tools remain derived, never
  seeded.
