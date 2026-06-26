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

**No dependencies.** The engine is pure standard-library Python, so the plugin runs on a
bare `python3` (3.9+, e.g. your system interpreter) — there is **no pip / uv / venv step**.
Installing wires up a guided skill, an MCP server, and a post-edit hook that keeps coverage
from regressing.

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

3. **Kick the tires first** (zero deps, bare `python3`) on the bundled example app:
   ```bash
   git clone https://github.com/GigaFlow-AI-Incorporated/gigaphone && cd gigaphone
   TMP=$(mktemp -d); cp -r testclient/app "$TMP/app"
   PYTHONPATH=src python3 -m gigaphone.cli discover --repo "$TMP" --scope app
   PYTHONPATH=src python3 -m gigaphone.cli fix --repo "$TMP" --scope app --apply   # prints the diffs
   ```
   `verify` then runs your representative path to confirm coverage. (The bundled demo app
   itself uses OpenTelemetry; install it — `pip install opentelemetry-sdk` — to run the full
   `onboard` end-to-end on the example.)

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
   │     • Language pack    python · typescript · rust (parsing + codemods) │
   │     • Boundary config  gigaphone.boundaries.yaml  (discovered per repo)│
   └───────────────────────────────┬───────────────────────────────────────┘
                                    ▼ emit + verify
     Backend adapter ▶ OTel/OpenInference · Braintrust · LangSmith · any OTLP
                                                            ← Vendor: where spans go
```

The engine carries **zero built-in assumptions** about any specific harness, language,
vendor, or codebase — each of those four axes is resolved independently, so they compose
freely (e.g. Codex × TypeScript × LangSmith × your gateway):

| Axis | What varies | How it plugs in |
|------|-------------|-----------------|
| **Harness** | how GigaPhone is driven & packaged (Claude Code, Codex; later Cursor, Gemini…) | harness adapter (`src/gigaphone/adapters/harness/`) |
| **Language** | the codebase's language (Python, TypeScript, Rust) | language pack (`src/gigaphone/packs/`) |
| **Vendor** | where spans are emitted & verified (Braintrust, LangSmith, Arize, Logfire, any OTLP) | backend adapter (`src/gigaphone/adapters/backend/`) |
| **Codebase** | the shape of *your* code, especially the LLM gateway | discovered **config**, not code (`gigaphone.boundaries.yaml`) |

The first three are pluggable **code** interfaces; the fourth is externalized **data** that
discovery learns once and commits. Discovery (the only place a model reasons) produces that
config; every routine run after that is deterministic — which is why GigaPhone can safely
edit production code and run head-less in CI.

## Contributing

Because of the four-axis design, most contributions are a small, well-bounded extension
rather than a change to the core. Pick your axis:

| Want to support… | Add a… | Where |
|------------------|--------|-------|
| a new language | **language pack** (parse + def-use + codemod emitters) | `src/gigaphone/packs/<lang>/`, register in `packs/registry.py` |
| a new observability vendor | **backend adapter** (emit + verify) | `src/gigaphone/adapters/backend/<vendor>/`, register in `adapters/registry.py` |
| a new agent harness | **harness adapter** (manifest + hooks) | `src/gigaphone/adapters/harness/`, then regenerate plugins |
| your own gateway shape | **nothing** — it's discovered config, not code | `gigaphone.boundaries.yaml` |

Dev loop (the engine itself is dependency-free; the dev/test tooling is not):

```bash
uv run --extra dev pytest          # full suite — must pass on Python 3.9 and 3.14
uv run --extra dev ruff check .    # lint
uv run --extra dev ruff format .   # format
```

Guidelines:

- **Keep each axis thin.** Logic must not leak from the neutral core into an adapter/pack —
  see the architecture rules in [`docs/golden-principles.md`](docs/golden-principles.md) and
  the decisions in [`docs/adr/`](docs/adr/) (immutable; reverse one with a new ADR, never an edit).
- **No fix without a red fixture, no coverage without verification.** Every fixable failure
  mode ships with a breaking test that proves the fix; a tool is only "covered" once a backend
  `verify()` confirms the span is nested and complete.
- **Plugin manifests come from one source.** Edit `src/gigaphone/adapters/harness/manifest.py`,
  then run `python scripts/build_plugins.py` (a test guards that committed files match).
- `AGENTS.md` is the contributor/agent quick-reference (commands, routing, prohibitions). The
  full design rationale is in [`docs/DESIGN.md`](docs/DESIGN.md).
