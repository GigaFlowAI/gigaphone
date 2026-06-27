# GigaPhone

**Get your AI agent's tool outputs into your traces — nested, complete, and verified.**

When an AI agent runs a tool (especially a code-execution tool), the result has to show up
in your observability backend as a span **nested under the agent's trace with the full
input and output**. If it doesn't, your eval/scoring platform can't see it. GigaPhone
finds the gaps, fixes them with reviewable edits, and **proves** the spans land by running
your code.

> The naive tool "adds a tracing decorator wherever one is missing." That's wrong. The real
> problem is rarely a missing decorator — it's that the tool result is produced *outside* the
> agent's span context, or logged in a *lossy* shape, so it disappears or lands in a detached
> trace. GigaPhone diagnoses **which** of those is happening and fixes that.

---

## Install

In Claude Code:

```
claude plugin marketplace add GigaFlow-AI-Incorporated/gigaphone
claude plugin install gigaphone@gigaphone
```

The engine is TypeScript and runs on **Node ≥20**; the plugin ships the built CLI
(`dist/cli.js`), so there is no per-repo build step. Installing wires up a guided skill (which
runs the engine via its CLI on demand) and a post-edit hook (`node dist/cli.js detect …`) that
keeps coverage from regressing. To *verify* a target codebase the engine launches that target's
runtime — `python3` for a Python repo, `node` for a TypeScript one — so the matching interpreter
needs to be on PATH (see [How it works](#how-it-works)).

*(Codex: point it at the repo — the skill lives at `.agents/skills/gigaphone/`.)*

## Get started — instrument your agent in minutes

1. **Install** the plugin (above).
2. **Open your agent's repo in Claude Code** and just say what you want:
   > *"My agent's tool outputs aren't showing up in our traces — instrument them."*

   GigaPhone takes it from there and **walks you through it**, gated at every step:

   | Step | What happens |
   |------|--------------|
   | **Discover** | finds your LLM gateway and tools — even a hand-rolled gateway with no SDK — and asks you to confirm |
   | **Diagnose** | tells you, per tool, *why* its output is missing (not traced / detached / truncated) |
   | **Fix** | shows each edit as a **diff you approve** — idempotent, minimal, no reformatting |
   | **Verify** | runs a representative path and confirms each tool span is **nested + complete** in your backend |

   Nothing changes without your approval, and nothing is called "fixed" until verify passes.
   The result is committed as `gigaphone.boundaries.yaml` so future and CI runs stay deterministic.

3. **Kick the tires first** on a bundled example app:
   ```bash
   git clone https://github.com/GigaFlow-AI-Incorporated/gigaphone && cd gigaphone
   npm install
   TMP=$(mktemp -d); cp -r testclient/app "$TMP/app"
   npx tsx src/cli.ts discover --repo "$TMP" --scope app
   npx tsx src/cli.ts fix --repo "$TMP" --scope app --apply   # prints the diffs
   ```
   `verify` then runs your representative path (launching the target's runtime) to confirm
   coverage. `testclient/` is the Python demo and `testclient-ts/` the TypeScript one; both
   capstones (red→green→idempotent) run end-to-end via `onboard`. (The Python demo uses
   OpenTelemetry; install it — `pip install opentelemetry-sdk` — to run the full flow.)

## How it works

**The core thesis: trace the consumption boundary; treat the sandbox as a black box.**
For an agent to act on a tool's result, that result must come back into the agent's process
and be handed to the model. There is always an **in-process consumption boundary** — the
function that feeds the execution output back to the agent, running on the normal call stack
inside the agent's span context. That seam is the correct and sufficient place to
instrument, *regardless* of how the sandbox ran the code (subprocess, Docker, E2B, a remote
worker). GigaPhone's whole job is to find that seam and make sure the result crosses it into
your trace. See [ADR-0003](docs/adr/0003-trace-the-consumption-boundary.md).

```
                 ┌─ you, in Claude Code / Codex ─┐   ← Harness: drives + packages
                 │ "instrument my tool outputs"  │
                 └───────────────┬───────────────┘
                                 ▼
   ┌──────────────────  GigaPhone engine (neutral core)  ──────────────────┐
   │                                                                        │
   │   discover ─▶ detect ─▶ plan ─▶ fix ─▶ verify ─▶ report                │
   │   find your   locate    classify apply   run a path,                   │
   │   gateway +   each       the      review- confirm spans                │
   │   tools       anchor      gap     able    nested + complete            │
   │               precisely           diffs                                │
   │                                                                        │
   │   parameterized inward by:                                             │
   │     • Language pack     python · typescript · rust (parsing + codemods)│
   │     • Codebase axis    gigaphone.boundaries.yaml (discovered config)   │
   │                        OR a CodebaseAdapter (code) for a known codebase│
   └───────────────────────────────┬───────────────────────────────────────┘
                                    ▼ emit + verify
  Backend adapter ▶ OTel · Braintrust · LangSmith · Logfire · Phoenix · any OTLP
                                                            ← Vendor: where spans go
```

The engine carries **zero built-in assumptions** about any specific harness, language,
vendor, or codebase — each of those four axes is resolved independently, so they compose
freely (e.g. Codex × TypeScript × LangSmith × your gateway):

| Axis | What varies | How it plugs in |
|------|-------------|-----------------|
| **Harness** | how GigaPhone is driven & packaged (Claude Code, Codex; later Cursor, Gemini…) | harness adapter (`src/adapters/harness/`) |
| **Language** | the codebase's language (Python, TypeScript, Rust) | language pack (`src/packs/`) |
| **Vendor** | where spans are emitted & verified (OTel, Braintrust, LangSmith, Logfire, Phoenix, any OTLP) | backend adapter (`src/adapters/backend/`) |
| **Codebase** | the shape of *your* code, especially the LLM gateway | discovered **config** (`gigaphone.boundaries.yaml`) **or**, for a *known* codebase, a `CodebaseAdapter` (`src/adapters/codebase/`) |

Harness, language, and vendor are pluggable **code** interfaces. The codebase axis is two-tier
(ADR-0010): an **unknown** codebase is externalized **data** that discovery learns once and
commits; a **known** codebase or framework may additionally ship a deterministic
`CodebaseAdapter` — code that recognizes bespoke dispatch the generic matcher misses and
declares its intentional-redaction model. Either way the result is materialized into committed
config. Discovery (the only place a model reasons) produces that config; every routine run after
that is deterministic — which is why GigaPhone can safely edit production code and run head-less
in CI.

## Contributing

Because of the four-axis design, most contributions are a small, well-bounded extension
rather than a change to the core. Pick your axis:

| Want to support… | Add a… | Where |
|------------------|--------|-------|
| a new language | **language pack** (parse + def-use + codemod emitters) | `src/packs/<lang>/`, register in `src/packs/registry.ts` |
| a new observability vendor | **backend adapter** (emit + verify) | `src/adapters/backend/<vendor>/`, register in `src/adapters/backend/registry.ts` |
| a new agent harness | **harness adapter** (manifest + hooks) | `src/adapters/harness/`, then regenerate plugins |
| a *known* codebase / framework | **codebase adapter** (bespoke recognition + redaction model) | `gigaphone codebase init <name>` scaffolds `gigaphone.codebase.ts`; bundle OSS ones in `src/adapters/codebase/` |
| your own gateway shape | **nothing** — it's discovered config, not code | `gigaphone.boundaries.yaml` |

The runtime shims that instrumented customer code imports stay in the **target** language
(`gigaphone.runtime.*` for Python, `@gigaphone/*` for TypeScript) and ship as **assets** under
`assets/runtime/{python,typescript}/` — they are not part of the TS engine. `verify` launches the
target's runtime with the shim on its path and reads the emitted spans back language-neutrally
(see [`ARCHITECTURE.md`](ARCHITECTURE.md) §4).

Dev loop (Node ≥20):

```bash
npm install              # install deps
npm test                 # full vitest suite — must pass
npm run typecheck        # tsc --noEmit (strict — 0 errors)
npx biome check src tests  # lint
```

Guidelines:

- **Keep each axis thin.** Logic must not leak from the neutral core into an adapter/pack —
  see the architecture rules in [`docs/golden-principles.md`](docs/golden-principles.md) and
  the decisions in [`docs/adr/`](docs/adr/) (immutable; reverse one with a new ADR, never an edit).
- **No fix without a red fixture, no coverage without verification.** Every fixable failure
  mode ships with a breaking test that proves the fix; a tool is only "covered" once a backend
  `verify()` confirms the span is nested and complete.
- **Plugin manifests come from one source.** Edit `src/adapters/harness/manifest.ts`,
  then run `npx tsx scripts/build-plugins.ts` (a test guards that committed files match).
- `AGENTS.md` is the contributor/agent quick-reference (commands, routing, prohibitions). The
  full design rationale is in [`docs/DESIGN.md`](docs/DESIGN.md).
