# ADR-0002: Neutral core, four axes of neutrality

- Status: Accepted
- Date: 2026-06-25

## Context

Tool outputs are lost during onboarding across wildly different setups: different
agent harnesses, languages, observability vendors, and codebase shapes. If the engine
encodes assumptions about any of these, every new customer is a fork. The diagnosis
("the tool result never reaches the trace, nested and complete") is identical across
all of them — only the surfaces differ.

## Decision

The engine carries **zero built-in assumptions** about a specific harness, language,
vendor, or codebase. Each axis is resolved independently behind a seam:

1. **Harness** (how GigaPhone is driven/packaged) → `HarnessAdapter` code interface.
2. **Language** (the codebase's language) → `LanguagePack` code interface.
3. **Vendor** (where spans are emitted/verified) → `BackendAdapter` code interface.
4. **Codebase** (this customer's code shape) → discovered **data** (`gigaphone.boundaries.yaml`),
   not code. See ADR-0004.

The first three are pluggable code; the fourth is externalized config. Axes compose
freely. A plan record names none of them (see ADR-0003 / §11). The engine never embeds
its own model calls — the harness is the reasoning engine (see ADR-0006).

## Consequences

- A new harness/language/vendor is an adapter or pack, not an engine change.
- A new codebase shape is config, not code.
- The hard ongoing discipline is keeping each surface **thin** — resist logic leaking
  out of the neutral core into any axis (DESIGN §16). Interfaces live in
  `src/gigaphone/interfaces/`; nothing axis-specific belongs in the core.
