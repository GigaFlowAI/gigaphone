# Design — Runtime instrumentation-fidelity eval framework

**Date:** 2026-07-02
**Status:** design (awaiting review) → implementation via writing-plans
**Owner:** gigaphone-eval

---

## 1. Problem & intent

GigaPhone's job (ADR-0003) is to instrument an agent codebase so tool/agent/LLM outputs
land in the observability backend as **nested, complete spans**. The eval we have today
scores **seam detection** — did GigaPhone point at the right function, statically, on source
code. That is the *input* to instrumentation, not the *output*.

Seam precision/recall cannot see the failure that matters most. Proof from a prior eval
run: the braintrust LLM fix injected
`from gigaphone.runtime.braintrust import gigaphone_llm_trace` — a symbol only the OTel shim
exports — so the instrumented agent **`ImportError`s at import time**. Seam P/R scored that
a perfect hit while the instrumentation was dead on arrival. (The LangSmith shim has the
identical latent gap.)

**Intent:** a reusable, multi-harness eval framework that measures the *emitted trace* —
run the instrumented agent, capture the spans GigaPhone actually emits, and score them
against a frozen golden. It is an **optimization target**: GigaPhone iterates against it the
way it drove static seam P/R to ≥0.9/0.9, but now on real runtime output. Hermes is the
first suite; every new harness plugs in as another suite.

### Non-goals

- Not a general OTel/trace-analysis library. The canonical schema (§4) carries only what the
  score needs.
- Not measuring model quality. The model is mocked; we test instrumentation, not the agent.
- Not vendoring harness source or run outputs into the engine repo (§7).

## 2. Decisions (settled in brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Purpose | Reusable **optimization target**, not a one-shot read. |
| D2 | Scope | **Multi-harness framework**; Hermes = suite #1; new harness → new suite. |
| D3 | Ground truth | **Hand-authored golden file per suite**, frozen + human-blessed. Hermes derives its golden from its Langfuse oracle; oracle-less harnesses author directly. |
| D4 | Success metric | Per-suite **hard gate** (runs without crashing AND all expected boundaries present) **+ tracked fidelity scalar** (nesting% + payload%), pushed upward, watched for regressions. |
| D5 | Plug-in model | **Declarative manifest + language-agnostic runner** (Approach B). The candidate output is already language-neutral JSON, so the runner/scorer are written once and drive Python or TypeScript harnesses alike. |
| D6 | Home | **In the gigaphone repo** (`eval/`), so it gates the engine in CI. Harness checkouts + run outputs stay out (referenced by path / gitignored). |

## 3. Architecture overview

```
eval/
  runner.py          # discovers suites, applies fix, runs workload x2 (determinism gate), scores, aggregates
  scorer.py          # BoundaryEvent[] candidate vs golden → gate + p/r/f1 + nesting% + payload%
  schema.py          # BoundaryEvent, gate/score result types
  dialects/          # per-span-source adapters → BoundaryEvent (§4)
    langfuse.py
    gigaphone_otel.py
    braintrust.py    # (as vendors are added)
  suites/
    hermes/
      suite.toml     # manifest (§5)
      golden.json    # frozen, blessed BoundaryEvent tree (§6)
      driver/run_turn.py   # native-language deterministic workload (§5)
  results/           # gitignored: per-run JSON + history for regression tracking
```

Data flow for one suite:

```
target_repo ──copy──► throwaway ──gigaphone fix (adapter, backend=otel)──► instrumented copy
                                                                                │
                          driver runs ONE deterministic turn (mocked LLM) ──────┤
                                                                                ▼
   Langfuse gold spans ──dialect:langfuse──►┐              gigaphone jsonl spans ──dialect:gigaphone_otel──►┐
                                            ▼                                                               ▼
                                   golden.json (frozen)  ◄──generate+bless once            candidate BoundaryEvent[]
                                            └──────────────► scorer.py ◄──────────────────────────┘
                                                                 │
                                              gate (pass/fail) + p/r/f1 + nesting% + payload%
```

The runner never imports harness code. It shells out to the driver, reads two JSON span
files, and scores. That is what makes it language-agnostic.

## 4. The canonical primitive: `BoundaryEvent` + dialect adapters

Different instrumentation systems emit different span dialects (Langfuse observations,
GigaPhone OTel attributes, braintrust spans…). They cannot be compared natively. Every
source maps into **one canonical schema**; the scorer only ever sees that.

```python
@dataclass
class BoundaryEvent:
    kind: Literal["root", "llm", "tool_exec", "agent"]   # the semantic boundary
    identity: tuple        # correlation key — see below; the p/r MATCH key
    parent: tuple | None   # parent's identity (structural ref, never a raw span_id)
    payload: dict          # canonical field names: model, messages, args, result, tool_name, ...
    display_name: str      # the raw name the instrumentation chose; a naming sub-score, NOT identity
```

**Dialect adapters** (`dialects/*.py`) each expose `to_boundary_events(raw) -> list[BoundaryEvent]`:

- `langfuse`: obs type `tool`→`tool_exec`, `generation`→`llm`, `chain`→`root`; identity from
  `tool_call_id` / call ordinal; payload from Langfuse input/output; `display_name="Tool: get_weather"`.
- `gigaphone_otel`: `kind` from the `gigaphone.kind` attribute; payload from `gigaphone.input`,
  `llm.model_name`, OpenInference attrs; `display_name="model_tools.handle_function_call"`.
- `braintrust` / `langsmith` / … : added per vendor as needed.

**This is the read-side mirror of GigaPhone's own write-side backend adapters.** GigaPhone
*writes* a boundary into otel/braintrust/langsmith/logfire/phoenix; the eval *reads* those
dialects back into a boundary. Same vendor axis, opposite direction — adding a vendor to the
eval is one read-adapter, exactly as adding one to GigaPhone is one write-adapter. The
scorer, gate, and suites are untouched.

### 4.1 The correlation key (the hard part)

Matching "the same tool call" across two independent instrumentations only works if both
expose a **run-invariant handle**. This is where fidelity actually lives, so it is its own
tested unit.

- **Preferred:** both carry `tool_call_id` (Langfuse records it; GigaPhone can be made to).
  identity = `(kind, tool_call_id)`.
- **Fallback:** `(kind, tool_name, ordinal_within_turn)` for tools; `(kind, call_ordinal)` for llm.
- If a dialect cannot produce a stable key, that suite drops to **structure-only** matching
  (tree shape without per-node identity) and the manifest records the downgrade.

**Names are never the match key.** Langfuse says `"Tool: get_weather"`, GigaPhone says
`"model_tools.handle_function_call"` — keying on name scores 0 recall while every boundary
was found. Name lands in `display_name` for an optional naming sub-score only.

## 5. Suite plug-in model

A suite is a directory the runner discovers. Its **manifest** is the only thing the runner
reads to drive it:

```toml
# eval/suites/hermes/suite.toml
name = "hermes"
language = "python"
target_repo = "/Users/jamesgao/Projects/hermes-agent"   # copied to a throwaway before fixing

[fix]
adapter = "hermes"      # gigaphone CodebaseAdapter to apply
backend = "otel"        # candidate emits via gigaphone's jsonl exporter

[workload]
command = "python driver/run_turn.py"   # runs ONE deterministic turn; writes candidate jsonl
# runner sets $GIGAPHONE_SPAN_FILE (candidate) and $GOLD_SPAN_FILE (gold) in the driver env

[gold]
dialect = "langfuse"    # how to read the gold spans the driver captured
golden = "golden.json"  # frozen, blessed expected tree

[candidate]
dialect = "gigaphone_otel"

[gate]
require_liveness = true                    # driver must exit 0 (no ImportError/crash)
require_boundaries = ["tool_exec", "llm"]  # every listed kind must be present or the gate fails

[score]
scalar = ["nesting", "payload"]            # blended into the tracked fidelity scalar
```

**Driver contract** — a suite's `driver/` is the only per-language piece. It MUST:
1. Run exactly one deterministic turn with the **model mocked** (no network), exercising
   ≥1 tool boundary and ≥1 llm boundary.
2. Point GigaPhone's instrumentation at `$GIGAPHONE_SPAN_FILE` (candidate jsonl).
3. Capture the harness's native/oracle spans to `$GOLD_SPAN_FILE` (used only when
   (re)generating the golden; see §6).
4. Exit non-zero on any error (this is the liveness signal).

The driver runs inside the *instrumented throwaway copy* with GigaPhone's runtime package on
`PYTHONPATH` (Python) or the equivalent for other languages.

## 6. Golden generation & the freeze discipline

The golden is **generated once, reviewed, and committed** — never recomputed from the oracle
on each eval run (that would let the oracle drift silently and defeat regression detection).

- `runner.py --bless <suite>`: runs the driver, reads `$GOLD_SPAN_FILE`, maps via the gold
  dialect → `BoundaryEvent[]`, writes `golden.json`. A human reviews the diff and commits.
- Normal `runner.py <suite>`: reads the **committed** `golden.json`; the oracle is not in the
  loop. If GigaPhone *legitimately* changes span naming/shape, the golden is updated in the
  same PR (standard snapshot-test hygiene).

**Golden scope.** Score the **leaf consumption boundaries** (`tool_exec`, `llm`). Track the
turn **root** separately as context — Langfuse emits a `"Hermes turn"` chain root; GigaPhone
wraps functions, not the turn, and may legitimately emit no root. That is a granularity
difference, not a miss, and must not tank recall.

**Honest caveat (recorded in-suite):** a Langfuse-derived golden inherits *Langfuse's*
opinion of where the boundaries are. Acceptable here because Hermes's boundary set was
independently justified (per-boundary `why`, prior `ground_truth.json`) and a human blesses
the frozen golden — but the golden is "Hermes's Langfuse contract, reviewed," not axiomatic
truth. Oracle-less suites author the golden directly against the same identity schema.

## 7. Determinism & assertion model

**1. Model mocked at source.** The driver scripts the client (Hermes:
`create.side_effect = [tool_turn, stop]`), so which tools fire, with what args, over how many
turns is fixed by fixture. GigaPhone's llm span comes from wrapping the harness *gateway
function*, which runs deterministically on the canned response — the mock sits at the SDK
boundary *below* GigaPhone's seam, so both gold and candidate fire in the **same run**.

**2. Volatile fields stripped before compare** — `trace_id`/`span_id`/`parent_id` values
(replaced by structural parent identity), timestamps, durations. Never asserted on.

**3. Tree asserted, siblings unordered** — compare each node's `(kind, identity)` and its
parent's identity. Siblings are an unordered set (Hermes has `parallel_execution_mode`;
tool-completion order is nondeterministic and must not fail us).

**4. Payload: per-field assertion mode, declared in the golden.**
```json
{ "kind": "tool_exec", "identity": ["tool_exec", "get_weather", "c_1"],
  "parent": ["root", "turn"],
  "payload": { "args":   {"mode": "value",   "expect": {"city": "Paris"}},
               "result": {"mode": "present"},
               "model":  {"mode": "value",   "expect": "gpt-4o"} } }
```
- `value` → normalized JSON equality (fixture-fixed fields: args, model, canned message).
- `present` → field exists and is non-empty (inherently volatile: token counts, usage).

**5. Determinism gate.** The runner runs each workload **twice**, normalizes both, asserts
byte-identical. A difference means a volatile field leaked into the normalizer — a
normalizer/harness bug we fix, not something fuzzy-matching hides. Scoring runs only after
the double-run is stable.

## 8. Scoring — gate + axes (D4)

Over the scored leaf `BoundaryEvent`s, keyed on identity:

- **Gate (pass/fail), per suite:**
  - *liveness* — driver exited 0 (no crash/ImportError). **This alone catches the braintrust
    class.**
  - *boundaries present* — every `gate.require_boundaries` kind appears (i.e. recall on those
    kinds = 1).
- **Reported metrics:**
  - *span p/r/f1* — over the leaf boundaries: recall = golden boundaries matched ÷ golden;
    precision = candidate boundaries matched ÷ candidate. (Spurious/duplicate spans hurt
    precision; missed hurt recall.)
  - *nesting%* — fraction of matched nodes whose parent identity matches golden. (The "nested"
    half of ADR-0003; a detached tool span scores 0 here even if present.)
  - *payload%* — fraction of matched nodes passing their per-field assertions. (The "complete"
    half.)
- **Tracked scalar** — blend of `score.scalar` axes (default `mean(nesting%, payload%)`),
  written to `results/history` for regression watch. Do **not** collapse the gate into the
  scalar; a suite reports `(gate: pass/fail, p/r/f1, nesting%, payload%, scalar)`.

**Backend liveness matrix.** Beyond the OTel fidelity run, the runner runs the fix once per
supported backend as a **liveness probe** and reports a pass/fail matrix. braintrust +
langsmith are expected-fail today (the `gigaphone_llm_trace` import gap) — a reported result,
the whole point of the eval.

## 9. Guardrails against fooling ourselves

- **Same-run gold+candidate** — a difference is a real instrumentation difference, not drift.
- **Determinism double-run** (§7.5) gates scoring.
- **Gold independence** — the gold dialect adapter shares no code with GigaPhone's fix; the
  golden is frozen, not GigaPhone's own output.
- **No oracle-path credit** — GigaPhone must reach the seams by its own detection
  (adapter/generic rule), never hand-pointed at `handle_function_call`.
- **Un-instrumented negative control** — scoring an un-fixed copy → empty candidate → span
  recall 0. Confirms the harness isn't reading the gold hooks as the candidate.

## 10. First suite: Hermes (concrete)

- **Source:** `/Users/jamesgao/Projects/hermes-agent` (the eval-outputs dir
  `gigaphone-eval/hermes` is NOT the source).
- **Driver:** build `AIAgent` with `client = MagicMock()`; script
  `chat.completions.create.side_effect = [tool_turn, stop]` (`_mock_response`/`_mock_tool_call`
  shapes from `tests/run_agent/test_run_agent.py:258/:249`); call `run_conversation("...")`.
  **Do NOT patch `handle_function_call`** (the existing example test does, which bypasses the
  tool seam and `post_tool_call` — the tool span would never appear). Backoff neutralized via
  `_fast_retry_backoff` (`tests/run_agent/conftest.py:26-47`).
- **Gold capture:** load the real Langfuse plugin, monkeypatch `_get_langfuse()` to a
  recording fake client (pattern: `_fake_client`,
  `tests/plugins/test_langfuse_plugin.py:263-304`) → gold spans to `$GOLD_SPAN_FILE`.
- **Candidate capture:** apply the HermesAdapter fix (backend=otel) to a full copy (Langfuse
  present); install a `TracerProvider` with GigaPhone's `_JsonlFileExporter`
  (`testclient/app/tracing.py:20-52`) → candidate jsonl to `$GIGAPHONE_SPAN_FILE`.
- **Golden tree (leaf boundaries scored):** `tool_exec:get_<tool>` + `llm:call#1` +
  `llm:call#2`, each parented to the turn root (root tracked as context).
- **Known references:** tool seam `model_tools.py:1174` (`_emit_post_tool_call_hook` in
  `handle_function_call`); llm bracket `conversation_loop.py:1101` / `:3811`; Langfuse
  register `plugins/observability/langfuse/__init__.py:1128-1137`.

### Implementation risk to spike first

Confirm GigaPhone's applied llm wrapper actually fires when `chat.completions.create` is a
`MagicMock` — the seam is the Hermes *gateway function* (which executes), but the decorator's
`model_attr`/`messages_arg` must resolve against the gateway's real args, not the mock. A
~10-line spike (apply fix, run one turn, assert an `llm` span lands in the jsonl) de-risks the
whole build before the scorer is written.

## 11. Build order

1. `schema.py` (`BoundaryEvent`, result types) + `dialects/gigaphone_otel.py` +
   `dialects/langfuse.py`, unit-tested against captured span samples.
2. Hermes driver + the §10 spike.
3. `scorer.py` (identity match, tree/nesting, per-field payload) + determinism double-run.
4. `runner.py` (discover, copy+fix, run, gate, score, aggregate) + `--bless`.
5. Hermes `suite.toml` + generate & bless `golden.json`.
6. Backend liveness matrix (braintrust/langsmith expected-fail).
7. Report rows (optimize page): gate, span p/r/f1, nesting%, payload%, per-backend liveness —
   distinguished from the static seam P/R, noting this measures instrumentation *output*.

## 12. Open questions

- **Correlation-key availability** (§4.1): does GigaPhone's tool span carry `tool_call_id`,
  or must we add it to the OTel shim? Resolve during step 1 by inspecting a real candidate
  jsonl; if absent, either extend the shim or accept the `(tool_name, ordinal)` fallback.
- **CI budget:** copying + fixing + running a harness per suite is heavier than a unit test.
  Likely a separate CI lane, not per-commit. Decide when >1 suite exists.
