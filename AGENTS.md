# AGENTS.md

Trace-coverage instrumentation for AI agent codebases. Neutral across **harness**,
**language**, **vendor**, and **codebase**. See `docs/DESIGN.md` for the why.

This file is a **pointer**, not documentation. Code and tests are the source of truth.

## Routing

- Architecture & theses → `docs/adr/` (immutable, numbered ADRs)
- Mechanical rules every change must hold → `docs/golden-principles.md`
- v1 scope & sequencing → `docs/IMPLEMENTATION_PLAN.md`
- Cross-session state → `progress.json` (structured; update at session end)
- The shared agent protocol body → `.agents/skills/gigaphone/SKILL.md`

## Commands

The engine is TypeScript (Node ESM, ≥20).

```
npm install                  # install deps
npx tsx src/cli.ts --help    # CLI from source: discover · detect · plan · resolve · review · fix · verify · onboard · codebase
npm run build                # tsc → dist/ + copy assets (astDump.py, runtime shims); then: node dist/cli.js <cmd>
npm run typecheck            # tsc --noEmit (strict — must be 0 errors)
npx biome check src tests    # lint (deterministic — must pass)
npm test                     # vitest run  (or: npx vitest run)
```

## Where things live

- Engine: `src/` — `core/` (neutral vocabulary), `interfaces/`, `engine/` (passes),
  `packs/<lang>/`, `adapters/{harness,backend,codebase}/`, `cli.ts`. Tests: `tests/` (vitest).
- Layering is enforced by `tests/architecture.test.ts` (lower layers never import higher;
  the engine talks to axes only through `interfaces/` + the registries). See `ARCHITECTURE.md`.
- Runtime shims for instrumented *target* code are assets, not engine code:
  `assets/runtime/{python,typescript}/` (ARCHITECTURE.md §4).

## Prohibitions

- Do **not** edit linter/config files to silence errors (`biome.json`, `tsconfig.json`).
- Do **not** hardcode a customer's gateway/code shape into the engine — it lives in
  `gigaphone.boundaries.yaml` (discovered config) or a `CodebaseAdapter`. See ADR-0004, ADR-0010.
- Do **not** embed model calls in the engine — the harness is the reasoning engine. ADR-0002.
- Do **not** add a built-in assumption about a specific harness, language, or vendor —
  it goes behind an interface (`src/interfaces/`). ADR-0002.
- The engine never declares a tool "covered" without a backend `verify()`. ADR-0005.

## Working agreement

Plan → execute one task → verify with tests before declaring done. Keep `AGENTS.md`
and ADRs current when a rule or boundary changes; broken pointers fail loudly,
stale prose rots silently.
