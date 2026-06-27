# GigaPhone — Architecture

> Machine-readable root artifact (harness-engineering: *repository-first knowledge*). This
> file states the module boundaries, the dependency layering, and the invariants that keep
> the codebase legible for both human and agent contributors. The rules here are not just
> documentation — the load-bearing ones are enforced by a **structural test**
> (`tests/architecture.test.ts`) and CI, so a violating change fails the build rather than
> rotting silently.

GigaPhone makes clean, analysis-ready telemetry the default for an agent harness and its
dependencies: it finds where tool/agent/LLM I/O fidelity is lost, classifies each loss, emits
deterministic instrumentation fixes as reviewable diffs, and verifies them against a freshly
captured trace. The engine is TypeScript; it instruments target codebases in *their* language.

## 1. Neutral core, four axes (ADR-0002)

The engine carries **zero built-in assumptions** about a specific harness, language, vendor,
or codebase. Each of those four concerns lives behind an interface (code) or in config (data),
and they compose freely (e.g. Codex × TypeScript × LangSmith × Acme's gateway):

| Axis | What varies | Where it lives |
|---|---|---|
| **Harness** | how the tool is driven & packaged (skill, hooks, manifest) | `adapters/harness/` (`HarnessAdapter`) |
| **Language** | parse + localize + emit byte-accurate codemods | `packs/` (`LanguagePack`) |
| **Vendor** | emit spans + verify them in the backend | `adapters/backend/` (`BackendAdapter`) |
| **Codebase** | bespoke boundary/redaction knowledge for a *known* codebase | `adapters/codebase/` (`CodebaseAdapter`) **or** discovered `gigaphone.boundaries.yaml` |

The codebase axis is two-tier: **unknown** codebases are handled as discovered data
(`gigaphone.boundaries.yaml`, ADR-0004); a **known** codebase/framework (OSS or a customer's
proprietary harness) may additionally ship a deterministic `CodebaseAdapter` that recognizes
bespoke dispatch the generic matcher misses and declares its intentional-redaction model
(ADR-0010). Either way its output is the same neutral `Descriptor` model and is materialized
into the committed config that deterministic passes consume.

## 2. Layered dependency flow (enforced)

A strict, one-directional import layering. **Lower layers must never import higher ones.**
The structural test enforces it; the neutral-core rule is the most important.

```
core            (model, boundary vocabulary, planRecord, sourceMap)   — depends on nothing
  ↑
interfaces      (LanguagePack, BackendAdapter, HarnessAdapter, CodebaseAdapter)
  ↑                                  ↑
config          packs/ + adapters/   (concrete axis implementations; import core + interfaces only)
  ↑                                  ↑
engine          (discover, detect, plan, resolve, fix, verify, review, report, project)
  ↑              — talks to axes only through interfaces + the registries
cli             (argument parsing + I/O; the only layer that does process/console I/O)
```

Enforced invariants:
- **`core/` imports nothing from `interfaces/`, `engine/`, `adapters/`, `packs/`, `cli`.** The
  core is the stable vocabulary; everything depends on it, it depends on no one.
- **`engine/` never imports a concrete adapter or pack directly** — only the `interfaces/` and
  the registries (`packs/registry`, `adapters/*/registry`). Swapping an axis implementation is
  invisible to the engine.
- **No layer imports `cli`.** I/O lives at the edge.

## 3. Determinism & the model boundary (ADR-0006)

No LLM sits in the routine analysis or per-tool-call runtime path. The harness model is the
reasoning engine only at **authoring/change time** (discovery, resolution, review); its output
is committed config that deterministic passes replay. Emitted instrumentation runs without the
model. `verify` is the oracle: a fix counts as coverage only when a freshly captured trace
shows the expected span **nested + complete** (ADR-0005) — never inferred.

## 4. Runtime shims are target-language assets, not engine code

The instrumentation that *fixed customer code imports* (`gigaphone.runtime.*` for Python,
`@gigaphone/*` for TypeScript) is necessarily in the **target** language. These shims are
shipped **assets** under `assets/runtime/<lang>/`, not part of the TS engine. `verify` launches
the target runtime (`python3 -m <module>` / `node <entry>`) with the shim on its path; the shim
emits spans as JSONL to `GIGAPHONE_SPAN_FILE`, which the engine reads back language-neutrally.
This is why a TypeScript engine still instruments Python codebases faithfully.

## 5. The agent loop (research → plan → execute → verify)

The onboarding flow mirrors the harness-engineering loop: **discover** (read the gateway/agent
loop, propose boundaries) → **plan/resolve** (confirm descriptors into committed config) →
**fix** (emit idempotent codemods as reviewable diffs) → **verify** (recapture a trace, assert
nested + complete) → re-diff until coverage is clean. Specific feedback (which field is missing
on which span) is what makes each pass converge.

## 6. Golden principles (taste invariants)

Mechanical, opinionated rules that keep the codebase consistent (enforced by lint + the
structural test where checkable):

- **Strict TypeScript**, ESM, `noUncheckedIndexedAccess`. Public types live in `core/model.ts`.
- **camelCase** identifiers; **wire strings are verbatim** (span names, attribute keys like
  `gigaphone.output.*` / `llm.*`, emitted import lines, idempotency tags). The neutral model
  serializes the YAML/JSON wire form at its edges, never leaking snake_case into logic.
- **Idempotent codemods**: every emitted edit carries a tag; re-applying changes nothing.
- **No fix without a red fixture**, and **no coverage without `verify`** (ADR-0005).
- **One purpose per module**; when a file grows past its job, split it.

## 7. Repository-first artifacts

Context the agent reads instead of re-deriving: this file, the ADRs under `docs/adr/`, the
design doc (`docs/DESIGN.md`), and `progress.json`. Decision records (ADRs) are the durable
"why"; keep them current when a rule changes.
