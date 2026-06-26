# GigaPhone — Design Spec

*Trace-coverage instrumentation for AI agent codebases — neutral across harness, language, vendor, and codebase*

Status: draft v0.4 · Owner: TBD · Last updated: 2026-06-25

---

## 1. Summary

GigaPhone runs over a customer's codebase and guarantees that AI agent **tool executions** — especially code-execution tools — are logged to the customer's observability platform as properly nested spans with complete inputs and outputs. If a tool's output never lands in the customer's trace, our eval platform cannot see or score it. Today those outputs are frequently lost during onboarding, which blocks activation.

GigaPhone is a **neutral core** designed against four axes of neutrality:

1. **Harness** — how GigaPhone is driven and packaged (Claude Code, Codex; later Hermes, Cursor, Gemini CLI).
2. **Language** — the codebase's language (Python and TypeScript in v1; pluggable beyond).
3. **Vendor** — where spans are emitted and verified (Braintrust, LangSmith, Arize/Phoenix, Logfire; any OTLP backend).
4. **Codebase** — the specific shape of *this* customer's code, especially its LLM/AI gateway, learned via discovery rather than hardcoded.

The first three are pluggable **code** interfaces (harness adapter, language pack, backend adapter). The fourth is externalized **data** (a per-codebase boundary config produced by discovery). The unifying principle: the engine carries zero built-in assumptions about a specific harness, language, vendor, or codebase — each lives behind an interface or in config. Axes compose freely (e.g. Codex × TypeScript × LangSmith × Acme's gateway).

The naive version of this tool adds a tracing decorator wherever one is missing. That is wrong and can make things worse: the real problem is rarely "no decorator" but that the tool result is produced outside the agent's span context, or logged in a lossy shape, so it disappears or lands in a detached trace. GigaPhone is a **span-coverage diagnostic and remediation tool**, and that diagnosis is identical across every harness, language, vendor, and codebase.

## 2. Goals and non-goals

**Goals**

- Detect, per tool, whether its execution result reaches the customer's backend nested under the correct agent trace with a complete payload; remediate gaps via reviewable, idempotent edits; verify against the live project.
- Be pluggable on all four axes: a new harness, language, or vendor is an adapter/pack, not a fork; a new codebase shape is discovered config, not code.
- Run as a standalone engine (CLI + library) so it works head-less in CI and degrades gracefully without any harness or agent.

**Non-goals (v1)**

- Reimplementing the agent. The harness *is* the reasoning engine; GigaPhone supplies the deterministic spine and protocols the harness fulfills. The engine never embeds its own model calls.
- Hardcoding any specific codebase's gateway shape into the engine. All codebase-specific knowledge lives in the boundary config.
- Re-running LLM discovery on every analysis. Discovery produces a committed config; routine runs consume it deterministically.
- Instrumenting *inside* execution sandboxes; fully autonomous edits; deep whole-program static analysis; platform migration.

## 3. Core thesis: trace the consumption boundary, treat the sandbox as a black box

For an agent to act on a tool result, that result must return into the agent's process and be handed to the model. There is always an **in-process layer that consumes the execution output and feeds it back to the agent**, running on the normal call stack inside the agent's span context. That is the correct and sufficient place to instrument, regardless of how the sandbox runs the code (subprocess, Docker, E2B, remote worker). The boundary is the seam that is neutral on all four axes — discovery finds it without knowing the harness, language pack, vendor, or anything hardcoded about the codebase.

## 4. Architecture: neutral core, four axes

```
 Harness axis:   Claude Code │ Codex │ ( Hermes │ Cursor │ Gemini … )
                        ▼  drive + package
        ┌──────────────────────────────────────────────────────┐
        │                GigaPhone neutral core                  │
        │   CLI engine · classifier · plan records · MCP         │
        │                                                        │
        │   parameterized inward by:                             │
        │     • Language Pack     (python, typescript, …)        │
        │     • Boundary config   (discovered per codebase)      │
        └──────────────────────────────────────────────────────┘
                        ▼  emit + verify
 Backend axis:   Braintrust │ LangSmith │ Arize │ Logfire │ generic OTel
```

Two **external** axes describe how the engine is driven and where output goes (harness, backend); two **internal** parameterizations describe what it reads and what shapes it knows (language pack, boundary config). A plan record carries none of them: "boundary at `exec.py:42`, `failure_modes=[off_context, lossy_output]`, complete-output fields = `[stdout, stderr, exit_code]`." Each axis is resolved independently, so they compose.

## 5. Harness-neutral engine and protocols

The core is a standalone CLI/library so any harness — or CI, or a human — can drive it.

```
gigaphone discover  → scan (optionally scoped) → propose boundary descriptors for confirmation
gigaphone detect    → run language-pack queries for confirmed anchors → candidate boundaries
gigaphone plan      → plan records (+ unresolved[] list)
gigaphone resolve   → ingest an agent-supplied resolution for an unresolved boundary
gigaphone fix       → apply codemods via the selected backend adapter + language pack; emit diffs
gigaphone verify    → backend-adapter verify against the live project
```

Two harness-neutral protocols, both JSON-in/ranges-to-read/JSON-out so any harness fulfills them identically:

- **Discovery protocol** (§8) — engine emits files/areas to read and the target descriptor schema; harness drives its model to propose boundary descriptors; user confirms; written to config.
- **Resolution protocol** — for the ambiguous ~20% the deterministic pass can't localize, engine emits `unresolved.json` (anchor locations, ranges, question, schema); harness returns `resolution.json`; `gigaphone resolve` ingests it.

The `SKILL.md` body (shared across harnesses) tells the model how to participate in both. Validate returned JSON against the schema and re-prompt on failure so quality doesn't depend on which harness drives the model.

## 6. Harness-adapter interface

Entire harness-specific surface; everything else (SKILL.md body, MCP server, language packs, codemods, specs, plan records) is shared.

```
HarnessAdapter:
  id                      # "claude-code" | "codex" | ...
  package(core)           # install artifact for this harness
  skill_frontmatter       # harness-specific SKILL.md metadata (body shared)
  register_mcp(server)    # wire the MCP verifier into this harness
  hook(event, command)    # post-edit / verify hook in this harness's format
  drive(task)             # invoke the harness's model for discovery/resolution protocols
  present_diff(diff)      # surface proposed edits via the harness's approval/diff UX
```

| Harness | Skill | Distribution | MCP | Hooks | Status |
|---------|-------|--------------|-----|-------|--------|
| Claude Code | `SKILL.md` (shared) | plugin manifest + marketplace | yes | event hooks | v1 |
| Codex | `SKILL.md` (shared) | plugin + marketplace (+ `agents/openai.yaml`) | yes | command hooks only | v1 |
| Hermes / Cursor / Gemini / … | `SKILL.md` (shared) | per-harness wrapper | per-harness | per-harness | future |

`SKILL.md` is the most portable artifact and MCP the shared substrate; the divergent bits are the manifest and hooks. Keep hooks to plain shell commands (Codex runs command hooks only) and generate both manifests from one source.

## 7. Language-pack interface

A language pack carries everything language-specific so the engine, classifier, specs, plan records, and both adapters stay language-neutral.

```
LanguagePack:
  id                  # "python" | "typescript" | ...
  grammar             # tree-sitter grammar
  anchor_queries      # S-expression queries for the anchor catalog in this language
  defuse_rules        # shallow same-file def-use (sink ← value ← producing fn)
  context_hop_sigs    # off_context signatures for this language's concurrency model
  codemod_emitters    # how to insert/wrap each backend primitive in this syntax
```

tree-sitter is the enabling choice: one query toolchain across languages, a concrete syntax tree (byte ranges for clean codemods), error-tolerant parsing, declarative queries. A new language = a new pack (grammar + queries + def-use + hop-signatures + emitters), no engine change. **v1 ships Python and TypeScript.** The pack also localizes the `off_context` signatures, since concurrency models differ (Python contextvars/thread pools vs TS AsyncLocalStorage/worker_threads).

### 7.1 Anchor catalog (carried by each pack)

Tool-result sinks (primary):
```
OpenAI chat:      {"role": "tool", "tool_call_id": ..., "content": <result>}
OpenAI responses: {"type": "function_call_output", "call_id": ..., "output": <result>}
Anthropic:        {"type": "tool_result", "tool_use_id": ..., "content": <result>}
LangChain:        ToolMessage(content=<result>, tool_call_id=...)
```
Dispatch/registry: dict registries, `if name == ...` switches, `@tool`/`function_tool`/`StructuredTool`. Argument parse: `json.loads(tool_call.function.arguments)` (OpenAI), `block.input` (Anthropic). Execution sinks (trace the wrapping function, not inside): py `subprocess`/`exec`/e2b/docker/modal/pyodide; ts `child_process`/`vm2`/`isolated-vm`/`worker_threads`. Context-hop: thread/process pools, `run_in_executor`, `asyncio.to_thread`, Celery/RQ, Temporal, `worker_threads`, callback dispatch, promises off the AsyncLocalStorage chain (`asyncio.create_task` copies context — don't flag).

## 8. Codebase neutrality: discovery → config

The engine hardcodes nothing about a customer's code shape. A hand-rolled `our_llm.chat(...)` gateway is invisible to built-in anchors, so the codebase-specific anchors must be *learned*. The answer is a hybrid: **LLM-assisted discovery produces a durable, committed boundary config; deterministic passes consume it.**

### 8.1 Why config is the source of truth (not a live scan each run)

GigaPhone edits production code and runs in CI, so the boundary set must be reproducible, reviewable, auditable, and runnable without an agent. A committed config gives determinism (no model re-deciding boundaries per run), a cache (no re-paying for a full-repo scan), a diff target (review what changed), and head-less CI support. The LLM is in the loop for **discovery and change**, never for routine analysis.

### 8.2 Discover before localize

Discovery determines *what to query for*; the AST pass finds *every instance precisely*. Two phases:

- **Phase A — discovery (semantic, breadth-first, agent-led, cheap).** grep provider SDKs, read the gateway module(s), understand the agent loop → propose the codebase-specific anchor set (gateway call, tool dispatch, execution boundary). Parsing is light; the goal is the *shape*, not byte precision. Output: boundary descriptors the user confirms.
- **Phase B — localization (syntactic, depth-first, deterministic).** Run the language pack's queries for the confirmed anchors (built-in + codebase-specific) across the repo, walk def-use to producing functions, classify failure modes, emit byte-accurate plan records for codemods.

"Autodetect the boundary before drawing the AST" = Phase A before Phase B. (Parsing still happens in B; A decides which anchor patterns B queries.)

### 8.3 Three ways to produce the config (one artifact)

A spectrum of increasing automation, all converging on `gigaphone.boundaries.yaml`:

1. **Hand-write** the spec — power users, CI-stable repos.
2. **Point at gateway file(s)** — `gigaphone discover --scope src/llm/` — agent reads only those, drafts descriptors, user confirms. Cheapest precise option; the recommended default.
3. **Full-repo scan** — agent finds candidate gateways/runners, drafts descriptors, user confirms.

Pointing at files is a *scoping hint* (narrows search, raises precision), not a separate mechanism.

### 8.4 Spec schema (backend- and harness-neutral)

```yaml
boundaries:
  - id: acme-gateway
    kind: llm                                # llm | tool_exec | tool_result_sink | agent_call
    match: { call: "our_llm.chat" }          # dotted name → generated per-language query
    input:  { arg: "messages" }
    output: { path: "response.text" }
    emit:   { name: "acme.llm" }             # type set by adapter from `kind`
  - id: acme-coderunner
    kind: tool_exec
    match: { call: "sandbox.execute" }
    input:  { arg: "code" }
    output: { paths: ["result.stdout", "result.stderr", "result.exit_code"] }  # complete result → fixes lossy_output
    emit:   { name: "acme.exec" }
```

- `agent_call` — a call that dispatches a whole sub-agent (black box by ownership);
  recognized via the Agent-SDK catalog (seed family B), wrapped like `tool_exec`.

`match.call` (dotted name) is language-neutral and compiles to a query in each active language pack; raw tree-sitter patterns are the per-language escape hatch. Built-in anchors are a bundled default pack in the same schema; project config overrides it and is authoritative.

### 8.5 Bidirectional harness review

Deterministic discovery is the high-precision proposer, but it is not complete: dispatches
built through factories, generic builders, or cross-module indirection are invisible to
structural matching, and some heuristics over-fire. The bidirectional harness review
(`gigaphone review`) is the high-recall + precision-audit pass: the harness (the reasoning
engine, ADR-0006) reads the proposed boundaries against the code, rejects false positives,
and adds missed boundaries; the result is written to the committed `gigaphone.boundaries.yaml`
as data (ADR-0004), so routine and CI runs replay it deterministically — the model is the
reasoning engine only at authoring/change time (see ADR-0009).

### 8.6 Drift

The committed config is checked against the codebase on each run; when discovery anchors no longer resolve (gateway moved/renamed, new provider added), GigaPhone flags drift and re-triggers Phase A for just the affected area. Discovery becomes an occasional, change-triggered step rather than a per-run cost.

## 9. Backend-adapter interface

Entire vendor-specific surface (emit + verify).

```
BackendAdapter:
  id, detect_presence(repo), config_schema, init_snippet(config),
  trace_boundary(node, kind),    # untraced fix
  restore_context(),             # off_context fix
  map_output(spec.output),       # lossy_output fix
  enable_framework(fw), verify(project, run)
```

**Two-tier:** a generic **OTel/OpenInference** adapter targets any OTLP backend (new platform = endpoint + headers, no code); **native** adapters (Braintrust, LangSmith) override where native semantics win. Selection: OTel already present → OTel adapter; native SDK present → that adapter; else the customer's platform.

| Platform | Family | Trace primitive | Context restore | Verify |
|----------|--------|-----------------|-----------------|--------|
| Generic OTel / OpenInference | OTLP | OpenInference + OTel span | OTel context API | backend OTLP query |
| Braintrust | native (contextvars) | `@traced` / `wrap_openai`, `span_type="tool"` | capture span, re-enter in worker | spans API by `span_type` |
| LangSmith | native (contextvars) | `@traceable(run_type="tool")` / `wrap_openai` | pass parent `RunTree` (`langsmith_extra`) | runs/traces API |
| Arize / Phoenix | OTel / OpenInference | `register()` + instrumentors | OTel context API | Phoenix/Arize spans API |
| Logfire | OTel-native | `logfire.span()` / `logfire.instrument_*()` | OTel context API | Logfire query / OTLP |

(Confirm exact APIs at implementation time.) Adapters cluster into contextvars-native and OTel families and reuse most fix logic within a family.

## 10. Failure-mode taxonomy (invariant on all four axes)

Properties of the customer's code, identical across harness, language, vendor, and codebase; only the fix primitive (from the backend adapter, emitted by the language pack) differs.

| Mode | What's happening | Fix |
|------|------------------|-----|
| `no_boundary` | No single consumption layer; exec calls inlined or scattered. | Introduce/consolidate the boundary, then trace. |
| `untraced` | Boundary exists, no span. | `trace_boundary(...)`, type = tool. |
| `off_context` | Traced but off the agent's context (pool/executor/queue) → orphan root trace. | `restore_context(...)` — capture + restore parent. |
| `lossy_output` | Traced but logs only the truncated model-facing string. | `map_output(...)` from the spec's complete-result fields. |

`off_context` is confirmed cross-platform and cross-language: Braintrust and LangSmith both nest via contextvars and orphan across thread pools; OTel and the TS AsyncLocalStorage model have the same hazard.

## 11. Fix engine and plan record

Codemods route off `failure_modes` to backend-adapter primitives rendered by the active language pack. Edits are **idempotent** (no double-wrapping; upgrade in place) and surfaced as **reviewable diffs** via the harness adapter; tree-sitter byte ranges mean inserts don't reformat the file.

```json
{
  "boundary": "tools/exec.py:42",
  "language": "python",
  "provider_or_framework": "anthropic | langgraph | acme-gateway",
  "kind": "tool_exec",
  "tools_covered": ["run_code", "run_bash"],
  "failure_modes": ["off_context", "lossy_output"],
  "complete_output_fields": ["stdout", "stderr", "exit_code"],
  "source": "anchor | framework | spec | agent"
}
```

## 12. Verification

After fixes, the engine runs a representative path and calls `backend_adapter.verify(...)` to confirm the expected tool spans appear — nested, complete — in the customer's project, using the same read path our eval platform uses. Output doubles as the onboarding artifact:

> Harness: Codex · Language: TS · Backend: LangSmith · 12 tools · 7 untraced · 3 off-context · 2 lossy. Fixed all 12. Verified trace: <link>.

## 13. Packaging and distribution

- **Neutral core**: CLI/library engine + `SKILL.md` body + classifier + codemod scaffolding + MCP verifier.
- **Language packs**: Python + TS in v1 (grammar + queries + def-use + hop-signatures + emitters).
- **Backend adapters**: generic OTel + Braintrust + LangSmith in v1.
- **Harness wrappers** (thin): Claude Code + Codex in v1, generated from one source.
- **Boundary config**: per-customer, produced by discovery, committed to their repo.
- Runs head-less in CI off the committed config for regression checks ("did anyone add an untraced tool?").

## 14. End-to-end onboarding flow

1. Customer runs GigaPhone in their repo via their harness.
2. Language packs detected; backend selected (existing SDK/OTel usage or customer choice; else generic OTel).
3. **Discovery**: scoped scan of the gateway (or full-repo) proposes boundary descriptors; customer confirms → `gigaphone.boundaries.yaml`.
4. Framework check → localization (built-in + config anchors) → classification → plan records; unresolved handled via the resolution protocol.
5. Adapter codemods presented as diffs via the harness; customer approves.
6. Idempotent edits applied; representative path run; `verify` confirms nested, complete tool spans.
7. Onboarding report (harness, language, backend, coverage before/after, verified trace link). Config committed for future deterministic / CI runs.

## 15. Phasing

**v1** — Python + TS language packs; Claude Code + Codex harness adapters; generic OTel + Braintrust + LangSmith backend adapters; discovery → committed config (scoped + full-repo) with drift detection; framework-first localization; the four fixes; MCP verification; head-less CI mode.

**v2** — more language packs; more harness adapters (Hermes/Cursor/Gemini); more backend adapters (Arize/Phoenix, Logfire) + multi-backend fan-out; richer interprocedural localization; optional in-sandbox sub-spans; shared library of customer gateway packs.

## 16. Open questions and risks

- **Four adapter/data surfaces to keep thin.** Resist logic leaking out of the neutral core into any axis. Backend leans on the generic OTel default; harness adapters stay manifest+hooks+drive+diff; language packs stay queries+emitters; codebase stays config.
- **Discovery determinism.** Phase A is LLM-driven; mitigate with strict descriptor schemas, user confirmation, and committing the result so the nondeterministic step happens once, not per run.
- **Config staleness / drift.** Needs reliable drift detection (anchors no longer resolve) and a low-friction re-discovery path, or configs silently rot and coverage regresses.
- **Recall on hand-rolled loops.** False negatives are the dangerous failure; need a confidence signal and a "couldn't resolve" report so nothing is silently skipped.
- **Representative-path execution.** Some customers lack a runnable path; fallback is instrument → wait for live traffic → verify asynchronously.
- **Cross-language def-use parity.** Shallow def-use must behave consistently across packs or coverage varies by language; treat the def-use contract as part of the pack spec.
- **`off_context` correctness.** Must match the customer's concurrency model; differs by language pack and backend family; most likely to need the resolution protocol.
