# ADR-0010: The codebase axis may be a deterministic CodebaseAdapter (code), not only config

- Status: Accepted
- Date: 2026-06-27
- Amends: ADR-0004 (codebase shape is discovered config), ADR-0002 (neutral core, four axes)

## Context

ADR-0004 externalized the codebase axis as discovered **data** (`gigaphone.boundaries.yaml`)
to keep routine/CI runs deterministic and to avoid an LLM re-deciding boundaries per run. That
remains right for **unknown** codebases. But for a **known** codebase or framework — an OSS
product (OpenHands, LangGraph apps) or a customer's proprietary harness (Arcanist) — generic
discovery is weaker than someone who *knows the code*: factory-built / registry / cross-module
dispatch is invisible to dotted-call matching, and the codebase's intentional-redaction model
(which secrets it deliberately scrubs) isn't expressible as boundary descriptors at all.

The deterministic, code-level recognition that ADR-0004 protected against was specifically an
**LLM** in the per-run path. Deterministic recognition *code* was always allowed — the language
packs' anchor catalogs and the agent-SDK catalog (`agentSdks`) already are exactly that.

## Decision

Introduce a fourth **code** interface, `CodebaseAdapter`, alongside harness/language/vendor.
It is authored *with knowledge of one codebase*:

- `detect(repo)` — selection (required).
- `scope()` / `discover(path, source)` — bespoke recognition → the neutral `Descriptor` model
  (the same the language packs emit), augmenting generic discovery.
- `redactionModel()` — fields the codebase intentionally redacts, which the auditor **preserves**
  (class D) rather than "fixing".
- `processBoundaries()` — where data crosses the codebase's process boundary (class-F reasoning).

All optional except `detect`. Authoring is scaffolded: `gigaphone codebase init <name>` writes a
`gigaphone.codebase.ts` stub the author fills in. OSS adapters are bundled with the engine; a
proprietary adapter lives in the customer's repo and is loaded by convention (default export of
`gigaphone.codebase.{mjs,js}`).

This preserves ADR-0004's real guarantees: a `CodebaseAdapter` is **deterministic code, no LLM**
(ADR-0006); its `discover()` output is materialized into the committed config at discover/review
time, so routine/CI passes still replay config. It preserves ADR-0002: the adapter speaks only
the neutral `Descriptor`/`Boundary`/`RedactionRule` model; the engine reaches it through the
interface + registry, never a concrete class.

## Consequences

- A known codebase gets precise, authored recognition (and redaction preservation) without
  hand-maintaining a large `boundaries.yaml` — and OSS adapters benefit everyone on that stack.
- The adapter is the answer to "where are my boundaries and what do I deliberately scrub"; the
  pipeline (language pack + backend adapter) still does the instrumenting and verification — the
  author never writes instrumentation code.
- Discovery precedence: codebase-adapter descriptors win ties over generic heuristics (authored
  knowledge beats pattern-matching); with no adapters the behavior is exactly generic discovery.
- The boundary config remains the durable, reviewable source of truth for routine/CI runs.
