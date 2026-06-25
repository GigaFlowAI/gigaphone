# ADR-0006: The harness is the reasoning engine; the core is a deterministic spine

- Status: Accepted
- Date: 2026-06-25

## Context

GigaPhone needs model reasoning for the semantic parts (discovery, resolving ambiguous
boundaries). It would be tempting to embed model calls in the engine. But that couples
the engine to a vendor/key, makes CI nondeterministic, and duplicates what every
harness already provides.

## Decision

The engine never embeds its own model calls. It is a standalone CLI/library that
emits and ingests **JSON-in / ranges-to-read / JSON-out** protocols; the harness drives
its own model to fulfill them. Two protocols (DESIGN §5):

- **Discovery protocol** — engine emits files/areas to read + the descriptor schema;
  harness proposes boundary descriptors; user confirms.
- **Resolution protocol** — for the ~20% the deterministic pass can't localize, engine
  emits `unresolved.json`; harness returns `resolution.json`; `gigaphone resolve` ingests it.

The shared `SKILL.md` body tells the model how to participate; the engine validates
returned JSON against the schema and re-prompts on failure, so quality does not depend
on which harness drives the model.

## Consequences

- The engine runs head-less in CI and degrades gracefully with no harness/agent.
- A new harness is a thin adapter (manifest + hooks + drive + diff), not a fork.
- Determinism is preserved: the nondeterministic step is isolated to protocol fulfillment
  and its output is schema-validated before the deterministic passes consume it.
