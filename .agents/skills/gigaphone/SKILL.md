---
name: gigaphone
description: Use when onboarding a codebase to trace-coverage, or when AI agent tool/code-execution outputs are missing, truncated, or landing in a detached trace in the observability backend (Braintrust, LangSmith, Arize, Logfire, or any OTLP). Drives GigaPhone's discovery and resolution protocols and presents fixes as reviewable diffs. Do NOT use for general tracing setup unrelated to agent tool spans.
---

# GigaPhone

You are driving **GigaPhone**, a trace-coverage tool. Its goal: every AI-agent **tool
execution** (especially code-execution tools) lands in the customer's observability
backend as a span **nested under the correct agent trace, with complete inputs and
outputs**. If a tool's output never reaches the trace, the eval platform can't score it.

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

Instrument the **in-process consumption boundary** — the layer that hands the execution
result back to the agent's model. Treat the sandbox (subprocess/Docker/E2B/remote) as a
black box; never try to instrument inside it.

## Workflow

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

## Resolution protocol (the ambiguous ~20%)

When `gigaphone plan` can't deterministically localize a boundary, it writes
`unresolved.json` (anchor locations, ranges to read, a specific question, and the answer
schema). Read the ranges, answer the question in the schema's shape, write
`resolution.json`, and run `gigaphone resolve`. Same validate-and-re-prompt loop. If you
genuinely can't resolve it, say so explicitly — never guess silently. False negatives are
the dangerous failure.

## Done means verified

A tool is "covered" only after `gigaphone verify` confirms its span is nested and
complete in the backend — not because a codemod was applied. Finish by reporting coverage
before/after and the verified trace link, and remind the user to commit
`gigaphone.boundaries.yaml` for deterministic / CI runs.
