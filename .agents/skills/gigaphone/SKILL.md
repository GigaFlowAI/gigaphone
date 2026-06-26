---
name: gigaphone
description: Use when onboarding a codebase to trace-coverage, or when AI agent tool/code-execution outputs are missing, truncated, or landing in a detached trace in the observability backend (Braintrust, LangSmith, Arize, Logfire, or any OTLP). Drives GigaPhone's discovery and resolution protocols and presents fixes as reviewable diffs. Do NOT use for general tracing setup unrelated to agent tool spans.
---

# GigaPhone

You are driving **GigaPhone**, a trace-coverage tool. Its goal: every call in the agent
loop — both the **LLM gateway call** and every **tool execution** (especially
code-execution tools) — lands in the customer's observability backend as a span **nested
under the correct agent trace, with complete inputs and outputs**. If an LLM call or a
tool's output never reaches the trace, the eval platform can't score it. GigaPhone proves
the *whole* trace tree end to end, not just that fixes were wired in.

The engine is a deterministic CLI. **You are the reasoning engine** for two semantic
steps only — discovery and resolution. The engine never calls a model; you do, through
the JSON protocols below. Everything else (localization, classification, codemods,
verification) is deterministic and you should just run it.

## Golden rule

The naive move — "add a tracing decorator wherever one is missing" — is **wrong** and can
make things worse. The real failure is almost never a missing decorator. It is one of:

| Mode | What's happening | Fix primitive |
|------|------------------|---------------|
| `no_boundary`  | exec calls inlined/scattered; no single consumption layer | introduce/consolidate, then trace |
| `untraced`     | a boundary exists but has no span | `trace_boundary(...)` |
| `off_context`  | traced but off the agent's context (thread pool / executor / queue) → orphan root trace | `restore_context(...)` |
| `lossy_output` | traced but logs only the truncated model-facing string | `map_output(...)` from complete fields |

**Boundary kinds:** these modes apply to every kind — `llm`, `tool_exec`, and `agent_call` (a call that wraps a whole sub-agent; the sub-agent is a black box *by ownership*, so recognize the dispatch via the Agent-SDK catalog and trace it like `tool_exec`, with span `kind=agent`). Out of scope: instrumenting inside the sub-agent.

Instrument the **in-process consumption boundary** — the layer that hands the execution
result back to the agent's model. Treat the sandbox (subprocess/Docker/E2B/remote) as a
black box; never try to instrument inside it.

The **LLM gateway** (`kind: llm`) is classified and fixed too — it is not assumed
already-traced. The same three modes apply with an OpenInference reading: `untraced` (no
span / no instrumentor), `lossy_output` (a span exists but misses the convention — input
messages, output, model, token usage, tool_calls), `off_context` (gateway called off the
agent context). For a recognized provider SDK (openai/anthropic/langchain) the fix enables
that provider's OpenInference instrumentor; for a hand-rolled gateway it records the
convention on the gateway span.

## Guided onboarding — walk the user through this

When the user wants to onboard their codebase (or reports lost/truncated/detached tool
spans), guide them step by step and run the engine **on demand** by invoking the CLI
(`python3 -m gigaphone.cli <verb>`, or `gigaphone <verb>` if installed). The engine is pure
stdlib, so just run it. Don't dump the whole pipeline at once; pause at each gate.

1. **Find the gateway.** Ask which directory holds their LLM gateway / agent loop (or grep
   for it). Run `gigaphone discover --scope <that path>` — the cheapest precise option (omit
   `--scope` to auto-crawl the whole repo).
   If the gateway scan finds no in-process LLM call but the repo dispatches to another agent
   framework (langgraph/crewai/openai-agents/openhands-sdk/…), discovery proposes an
   `agent_call` boundary from the Agent-SDK catalog. If you see a dispatch that looks like a
   sub-agent but matches no catalog entry, ask the user to confirm it (resolution protocol),
   then offer to contribute the new signature back to `packs/python/agent_sdks.py` as an OSS
   PR — you draft the entry with `agent_sdks.format_entry(...)`.
2. **Confirm the boundaries.** Show the user the discovered descriptors in plain language
   ("found your gateway `X`, and 3 tools: …"). Get a yes before they're committed to
   `gigaphone.boundaries.yaml`.
3. **Review the proposal (recall + precision).** Deterministic discovery is high-precision
   but not complete, and some heuristics over-fire. Read the proposed boundaries against the
   code and adjudicate, then run `gigaphone review review.json`:
   - **Prune false positives (precision).** For each proposed boundary, confirm it is a real
     LLM gateway, tool execution, or sub-agent dispatch. Reject the ones that are not — e.g. a
     singleton accessor like `get_docker_client` (returns a client object), or a pure
     validator like `is_valid_git_branch_name` (shells out only to validate a string). Put
     their ids in `review.json` `reject`.
   - **Recover misses (recall).** Sweep the gateway / dispatch area for boundaries discovery
     could not localize structurally — most importantly a sub-agent dispatch sent over a
     transport (an `httpx`/`requests` `.post` to a remote agent-server, a config built via a
     factory then serialized). Add each as a descriptor in `review.json` `add` with
     `kind: agent_call`, the enclosing function as `match_call`, and the complete-result
     fields as `output_paths`. `output_paths` are the field names the boundary's call returns
     that should become span attributes — for a tool exec typically `stdout`, `stderr`,
     `exit_code`; for a sub-agent dispatch the fields of its result object such as `events` or
     `final_message` (read the dispatch/return type to pick them); they land as
     `gigaphone.output.<field>` attributes on the span.
   - The result is committed to `gigaphone.boundaries.yaml`, so CI replays it deterministically
     — the model is in the loop only here, at authoring/change time.
4. **Explain what's wrong.** Run `gigaphone plan`; summarize per boundary (LLM gateway +
   each tool) which failure mode it has (untraced / off_context / lossy_output) and what
   the fix does.
5. **Show the diffs.** Run `gigaphone fix` (without `--apply` to preview, then `--apply`);
   present each codemod as a reviewable diff and get approval before applying. The edits are
   idempotent — re-running changes nothing.
6. **Prove it end-to-end.** Run `gigaphone verify`; it runs a full agent turn and proves
   **one coherent trace tree** — a single agent root with every LLM and tool span nested +
   complete, and each requested tool causally linked to its span. If anything is still ✗
   (orphan, missing convention, broken linkage), say so — never claim coverage without verify.
7. **Wrap up.** `verify`/`onboard` also writes `docs/gigaphone/report.md` (problems +
   changes + verification) and `docs/gigaphone/architecture.md` (the integrated telemetry
   architecture). Tell them to commit those plus `gigaphone.boundaries.yaml` so future/CI
   runs are deterministic, and that the post-edit hook will flag any newly-added untraced
   tool or gateway.

The engine is pure stdlib and runs on a bare `python3` — no install step; just invoke it.

## Workflow (the verbs behind the steps)

```
gigaphone discover [--scope PATH]   you fulfill the Discovery protocol → boundary descriptors
gigaphone detect                    deterministic: queries for confirmed anchors → candidates
gigaphone plan                      deterministic: plan records (+ unresolved[])
gigaphone resolve                   you fulfill the Resolution protocol for unresolved items
gigaphone fix                       deterministic: codemods as reviewable diffs (idempotent)
gigaphone verify                    deterministic: backend verify against the live project
```

Confirm boundary descriptors with the user before they are written to
`gigaphone.boundaries.yaml`. Present every codemod as a diff for approval before applying.

## Discovery protocol (you propose, the engine consumes)

`gigaphone discover` emits a task: a list of files/areas to read and the **boundary
descriptor schema**. Prefer `--scope` at the LLM gateway directory — it is the cheapest
precise option. Then:

1. Read only the indicated files. grep provider SDKs (openai/anthropic/langchain), find
   the gateway module(s) and the agent loop. Goal is the **shape**, not byte precision.
2. Identify the codebase-specific anchors: the LLM gateway call, the tool-dispatch site,
   and the execution boundary (the function wrapping subprocess/exec/sandbox calls).
3. Emit boundary descriptors matching the schema exactly — `kind` (`llm` | `tool_exec` |
   `tool_result_sink`), `match.call` (dotted name), `input`, `output` (complete-result
   fields for `tool_exec` — e.g. `stdout`, `stderr`, `exit_code`), `emit.name`.
4. The engine validates against the schema and **re-prompts you on any mismatch** — fix
   and resubmit. Present the descriptors to the user to confirm before they're committed.

   review.json shape: `{ "reject": ["<descriptor id>", ...], "add": [ { "id", "kind",
   "match_call", "input_arg"?, "output_paths"?, "emit_name"? }, ... ] }`. Anything not rejected
   is kept. `match_call` in `review.json` corresponds to `match: {call: ...}` in the committed
   yaml — the engine translates the flat key to the nested form. If `emit_name` is omitted the
   engine derives a span name from the boundary; for an added sub-agent dispatch prefer an
   explicit name like `<project>.subagent.<framework>` so the span reads clearly.

## Resolution protocol (the ambiguous ~20%)

When `gigaphone plan` can't deterministically localize a boundary, it writes
`unresolved.json` (anchor locations, ranges to read, a specific question, and the answer
schema). Read the ranges, answer the question in the schema's shape, write
`resolution.json`, and run `gigaphone resolve`. Same validate-and-re-prompt loop. If you
genuinely can't resolve it, say so explicitly — never guess silently. False negatives are
the dangerous failure.

## Done means verified

A boundary (LLM or tool) is "covered" only after `gigaphone verify` confirms its span is
nested and complete **and part of one coherent trace tree** — not because a codemod was
applied. Finish by reporting coverage before/after and the verified trace link, point the
user at the generated `docs/gigaphone/report.md` and `architecture.md`, and remind them to
commit those plus `gigaphone.boundaries.yaml` for deterministic / CI runs.
