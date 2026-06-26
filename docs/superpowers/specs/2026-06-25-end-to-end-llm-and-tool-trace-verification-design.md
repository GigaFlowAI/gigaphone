# End-to-End LLM + Tool Trace Verification — Design Spec

Status: draft v1 · Date: 2026-06-25 · Repo: `gigaphone`

---

## 1. Summary

Today GigaPhone instruments and verifies **tool executions** only. It discovers the LLM
gateway purely as a trace-root anchor and assumes it is "already traced" (`pack.py:204`:
`if d.kind == BoundaryKind.LLM: return b` — no failure modes, no fix). The verifier checks
each tool span in isolation; it never asserts that the *whole* trace — LLM calls and tool
calls together — forms one coherent tree.

This feature makes the **LLM gateway a first-class boundary** (classified *and* fixed, like
tools) and upgrades verification to prove an **end-to-end coherent trace tree**. It also
makes GigaPhone emit human-readable **markdown artifacts** — a consolidated problem/change
report and a telemetry architecture document — alongside the code edits.

The change is **additive** to the existing `discover → detect → plan → fix → verify →
report` spine. No new top-level verbs; no change to the MCP surface or the guided SKILL
flow. The user experience ("walk me through it, gated at each step") is unchanged — it now
covers LLM calls and produces docs.

## 2. Goals / non-goals

**Goals**
- LLM gateway boundaries are classified into the existing failure-mode taxonomy and fixed.
- "Complete" LLM span = the **full OpenInference LLM convention**: input messages, output
  messages/text, model name, token usage (prompt/completion), and any `tool_calls` the
  model requested.
- A single `verify` run proves **one coherent trace tree**: a root agent span with every
  LLM and tool span nested under it, each complete, and the model's tool request causally
  linked to the resulting tool span.
- GigaPhone emits committed markdown: `docs/gigaphone/report.md` (problems + changes + why)
  and `docs/gigaphone/architecture.md` (the integrated telemetry architecture).

**Non-goals (this iteration)**
- Re-deriving provider span attributes by hand. For recognized SDKs we **enable the
  provider's OpenInference instrumentor** rather than owning an extraction layer (Approach
  A; see §5).
- Instrumenting inside execution sandboxes (unchanged from the core thesis).
- Solving the "customer has no runnable path" case — end-to-end verify requires a
  representative path that exercises at least one full agent turn (§6.4); the
  instrument-and-wait-for-live-traffic fallback is out of scope here.
- TypeScript parity in the first cut — Python pack lands first; the TS pack follows the same
  contract (§9).

## 3. Locked requirements (from brainstorming)

| # | Decision |
|---|----------|
| 1 | LLM boundary is **verify + fix** (first-class), not verify-only. |
| 2 | LLM completeness target = **full OpenInference LLM convention**. |
| 3 | End-to-end success = **one coherent trace tree** with causal LLM→tool linkage. |
| 4 | Output docs = **single `report.md`** + **`architecture.md`**, committed under `docs/gigaphone/`. |
| 5 | Fix strategy = **Approach A**: enable provider instrumentor for known SDKs; hand-roll only the bespoke-gateway fallback. |

## 4. Pipeline changes (additive)

| Stage | Today | Change |
|-------|-------|--------|
| `discover` (`packs/python/pack.py`) | emits `kind: llm` descriptors for hand-rolled gateways + grep'd SDKs | also record a **provider tag** (`openai` / `anthropic` / `langchain` / `hand_rolled`) on the descriptor |
| `detect`/`analyze` (`pack.py:204`) | LLM returns early, no failure modes | **classify** LLM boundaries into `untraced` / `lossy_output` / `off_context` vs the OpenInference convention (§5) |
| `plan` (`plan.py:57`) | LLM excluded from `unresolved` and `fixable` | LLM boundaries flow through like tools; the `!= LLM` guard is removed |
| `fix` (`fix.py`, adapter, pack) | tool primitives only | add the **LLM fix primitive** — enable instrumentor, or hand-rolled LLM span (§5) |
| `verify` (`adapters/backend/otel/adapter.py`) | per-boundary tool checks | build + assert the **whole trace tree** (§6) |
| `report` (`engine/report.py`) | onboarding summary string | also emit `docs/gigaphone/report.md` + `architecture.md` (§7) |

## 5. LLM boundary: classification + fix

### 5.1 Classification (`detect`/`analyze`)

Replace the `pack.py:204` early return with real classification. The taxonomy is **reused**
— no new `FailureMode` values — with an LLM-specific reading:

| Mode | LLM meaning | Detection (Python pack) |
|------|-------------|-------------------------|
| `untraced` | no span around the gateway call **and** no provider instrumentor active | no enclosing span at the boundary, and no `*Instrumentor().instrument()` / `wrap_openai` in project init |
| `lossy_output` | a span exists but is missing convention attrs (model, usage, messages, tool_calls) | span present but required OpenInference attrs not set |
| `off_context` | gateway invoked from a pool/worker → orphan root | existing `_find_context_hop` logic, unchanged |
| *(covered)* | instrumentor already active, or hand-rolled span already complete | no failure mode; kept for drift, as today |

- `no_boundary` **does not apply** to LLM calls — a gateway is a single call site, so there
  is always a boundary to instrument. Only the three modes above are reachable.
- Two new cheap inputs: the **provider tag** (set in `discover` from the import map / SDK
  grep) and a **convention-completeness check** (which required OpenInference attrs an
  existing span carries) — mirroring the tool path's `requires_complete_attrs` /
  `complete_output_fields`, but against a fixed attribute set.

The required OpenInference attribute set (the verify + completeness target):
`llm.input_messages`, `llm.output_messages` (or `llm.output.text`), `llm.model_name`,
`llm.token_count.prompt`, `llm.token_count.completion`, and `llm.tool_calls` when the
response requested tools.

### 5.2 Fix — Approach A, two paths

Selected by the provider tag; both flow through the existing
`backend.primitive_for(boundary, mode)` → `pack.emit_fix(...)` machinery.

**Path 1 — recognized provider SDK (≈90%).** Fix = **enable the provider's OpenInference
instrumentor once at app init** (not wrap the call site). New backend-adapter primitive
`enable_llm_instrumentation(provider)` returns import + init lines, e.g.:

```python
from openinference.instrumentation.openai import OpenAIInstrumentor  # gigaphone:llm:openai
OpenAIInstrumentor().instrument()                                    # gigaphone:llm:openai
```

- Placed at the telemetry-init site (where the `TracerProvider` is configured — the OTel
  adapter's `init_snippet` already locates/creates this).
- `untraced` → add the instrumentor. `lossy_output` from a thin hand-written span →
  enabling the instrumentor supersedes the partial span. Idempotent via the
  `gigaphone:llm:<provider>` tag, exactly like existing tool tags.

**Path 2 — hand-rolled gateway (no SDK).** Falls back to the tool-style decorator the
engine already emits, in an LLM shape: `gigaphone_trace(kind="llm", ...)` capturing
`messages` (input), the return text/messages (output), model, and usage from the gateway
function's args + return. Reuses the `UNTRACED` / `LOSSY_OUTPUT` emitter paths in
`pack.emit_fix`, rendering LLM attrs instead of tool output fields.

**`off_context`** (either path) reuses the existing `gigaphone_propagate` executor-wrapper
fix unchanged — orphaning is the same hazard for LLM and tool boundaries.

**Runtime shim:** `src/gigaphone/runtime/otel.py` gains an LLM-aware helper that sets the
OpenInference `llm.*` attributes for the hand-rolled path. The instrumentor path needs no
shim.

## 6. End-to-end trace-tree verification

### 6.1 What "working" means

A single `verify` run must prove **one coherent trace tree**, not a set of independent
spans:

1. **Single root.** Every captured span chains up to one root agent span — no orphan roots.
2. **LLM coverage.** Every LLM boundary's span is present, nested under the root, and
   carries the full OpenInference convention (§5.1).
3. **Tool coverage.** Every tool boundary's span is present, nested, and complete
   (unchanged behavior, now part of the tree assertion).
4. **Causal linkage.** For each LLM span that requested tools (`llm.tool_calls` with
   call ids), a corresponding tool span exists in the tree. Match by `tool_call_id` when
   available, else by tool name. This is what proves the *loop* is wired, not just the parts.

### 6.2 How it's computed

Extends `OtelAdapter.verify` / `_run_and_capture` in `adapters/backend/otel/adapter.py`,
which already runs a representative module and captures spans to a JSONL file via
`GIGAPHONE_SPAN_FILE`. Additions:

- Build the parent→child tree from captured spans (the `_is_descendant` helper already
  exists). Compute the set of roots; assert exactly one agent root.
- Evaluate LLM expectations (new) and tool expectations (existing) against the tree.
- Evaluate linkage: collect `tool_calls` ids from LLM spans, match to tool spans.

### 6.3 Result shape

Add a tree-level result alongside the existing per-boundary `VerifyResult[]`:

```
TreeVerifyResult:
  single_root: bool
  root_span_name: str | None
  llm:   list[VerifyResult]     # per LLM boundary: present / nested / complete
  tools: list[VerifyResult]     # per tool boundary (as today)
  linkage: list[{tool_call_id|tool, linked: bool}]
  ok: bool                       # all of the above pass
```

A tool/LLM is "covered" only when its span is present, nested, complete **and** part of the
single coherent tree — never because a codemod was applied.

### 6.4 Representative-path requirement

End-to-end verify needs a path that exercises at least one full turn (LLM → tool → LLM). If
the representative module produces no tool span or no LLM span, verify **reports that the
path didn't exercise a full round-trip** rather than passing vacuously. (Customers without a
runnable path are out of scope here — §2.)

## 7. Documentation generation

Deterministic, extends `engine/report.py`. Generated from plan records + fix result +
verify result + the boundary config — no model call. Written under `docs/gigaphone/` in the
customer's repo and committed via the normal gated flow.

### 7.1 `report.md` (single consolidated)

- **Summary** — harness · language · backend · coverage before/after · verified trace link.
- **Problems found** — per boundary: `file:line`, kind (llm/tool_exec), failure mode, and a
  plain-language "why this loses telemetry."
- **Changes applied** — per edit: file, what changed (diff summary), and the rationale
  (which failure mode it resolves, why this seam).
- **Verification** — the `TreeVerifyResult`: single-root ✓, per-span nested+complete table,
  linkage table, trace link. Honest ✗ where anything failed.

### 7.2 `architecture.md`

Describes the telemetry architecture that was integrated, generated from the boundary config
+ adapters in play:

- The **trace tree shape** (root agent → LLM spans + tool spans), as an ASCII diagram.
- **Where spans are emitted** — each boundary (`file:line`, kind, span name) and the
  mechanism (provider instrumentor vs gigaphone decorator vs context-restore wrapper).
- **Backend + init** — adapter selected, init snippet location, instrumentors enabled,
  runtime shim.
- **Regression protection** — the committed `gigaphone.boundaries.yaml`, the post-edit hook,
  and head-less CI usage.

## 8. File-by-file change map

| File | Change |
|------|--------|
| `core/model.py` (`Descriptor`, `Boundary`) | add `provider` tag; LLM completeness fields |
| `core/boundary.py` | no enum changes (taxonomy reused); doc the LLM readings |
| `packs/python/pack.py` | provider tag in `discover`; classify LLM in `_analyze_fn` (replace `:204` early return); LLM-shaped `emit_fix` for hand-rolled path |
| `plan.py` | remove the `!= BoundaryKind.LLM` guard at `:57`; LLM records flow through |
| `interfaces/backend_adapter.py` | add `enable_llm_instrumentation(provider)` to the interface |
| `adapters/backend/otel/adapter.py` | LLM primitive (instrumentor enable); LLM expectation builder; tree-level verify + linkage; `TreeVerifyResult` |
| `adapters/backend/braintrust`, `langsmith` | implement `enable_llm_instrumentation` (native `wrap_openai` where it wins) |
| `runtime/otel.py` | LLM-aware attribute helper for the hand-rolled path |
| `engine/report.py` | emit `report.md` + `architecture.md` |
| `engine/verify.py` | thread the tree result through |
| `skills/gigaphone/SKILL.md` | mention LLM coverage + the two emitted docs in the guided flow |
| `tests/` | red fixtures per failure mode + e2e tree + doc-generation tests (§9) |

## 9. Testing strategy

Per golden principle "no fix without a red fixture, no coverage without verification":

- **Red fixtures** (each fails before the fix, passes after):
  - SDK gateway, untraced (no instrumentor) → instrumentor enabled.
  - Hand-rolled gateway, lossy (missing usage/messages) → completed.
  - LLM call behind a thread pool → `off_context` restored.
  - Hand-rolled gateway, untraced → decorator emitted.
- **End-to-end** (`tests/test_e2e_onboarding.py`): extend the `testclient` app to run a full
  agent loop (LLM → tool → LLM); assert the `TreeVerifyResult` — single root, LLM + tool
  spans nested + complete, linkage present.
- **Doc generation**: assert `report.md` + `architecture.md` are produced, contain the
  expected problem/change/architecture sections, and are deterministic (stable across runs).
- **Idempotency**: re-running `fix` makes no change (instrumentor + decorator tags dedupe).
- Must pass on Python 3.9 and 3.14 (existing CI matrix).

## 10. Risks / open questions

- **Instrumentor availability.** Enabling a provider instrumentor adds an `openinference-*`
  dependency to the *customer's* app (not the engine). The report must call this out, and
  the fix should detect whether the package is importable and, if not, surface the
  install step rather than emitting a broken import.
- **Representative path coverage.** If the customer's path doesn't hit a tool, linkage can't
  be proven; verify must say so (not pass vacuously).
- **Hand-rolled extraction fidelity.** The Path-2 decorator infers messages/model/usage from
  the gateway signature; ambiguous gateways route through the existing resolution protocol
  rather than guessing silently.
- **TS parity.** The TypeScript pack must implement the same provider tag + LLM
  classification + emitters to avoid coverage varying by language.

## 11. Out of scope

- Customers with no runnable representative path (live-traffic async verify).
- Multi-backend fan-out.
- Instrumenting inside sandboxes.
- Non-Python packs beyond the contract definition (TS follows in a fast-follow).
