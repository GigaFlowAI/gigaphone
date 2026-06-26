# Design: the `agent_call` boundary — instrumenting harnesses that wrap whole agents

Status: approved (brainstorm), pending implementation
Date: 2026-06-26
Related: DESIGN §3, §7.1, §8.4, §10, §11; ADR-0002, ADR-0003, ADR-0006; SKILL.md golden rule

## Problem

GigaPhone's discovery is bottom-up: it anchors on the in-process LLM/exec/dispatch site
and localizes the consumption boundary around it. That strategy **structurally fails on a
class of OSS harnesses that wrap another agent as a whole** — they hold no in-process LLM
call to anchor on.

Worked example — **OpenHands** (`openhands-ai`, the app/server layer):

- No `litellm.completion` and no agent step loop in-process. `utils/llm.py` is only
  model-list logic.
- Conversations are built as an `openhands.sdk.Agent` config and `httpx.POST`ed to a
  **remote agent-server** (`agent_server_url`, `AsyncRemoteWorkspace`); tool execution is
  proxied over HTTP.
- `gigaphone discover --scope openhands` therefore finds only false positives
  (`get_docker_client`, `is_valid_git_branch_name`) — neither a real boundary.

The harness has real, valuable trace surface — "we handed a task to a sub-agent and got a
result back" — but GigaPhone today cannot see it.

## Key idea: a sub-agent is a black box *by ownership*

GigaPhone's golden rule already says: treat the sandbox (subprocess/Docker/E2B/remote) as
a black box; never instrument inside it; trace the in-process consumption boundary. A
**sub-agent is exactly that black box**, drawn by *responsibility* rather than transport:

> GigaPhone instruments on behalf of the repo owner, and the repo owner is only responsible
> for **their own harness boundary** — not for what the sub-agent does internally. OpenHands'
> devs own "called sub-agent X with task T, got result R"; they do not own the sub-agent's
> (Codex's / their agent-server's) insides.

Consequences:

1. An `agent_call` is structurally a `tool_exec`: a black-box call you wrap **at the
   wrapper**, capturing complete I/O — never reaching inside.
2. **Out of scope, deliberately**: propagating trace context *into* the sub-agent so its
   own spans nest. That would be instrumenting someone else's harness, is not the user's
   responsibility, and is not verifiable as theirs. Cross-harness trees compose at the
   backend iff both ends export — emergent, owned by no single party.
3. `off_context` still applies, but **scoped to the user's own process**: if the harness
   dispatches the agent call from a detached async task / thread pool, the span orphans off
   *the harness's own* root trace. `restore_context` keeps it attached to the user's root.
   The line is sharp: keep the span under *your* root; never reach into the sub-agent's.

## What's new vs. reused

The design is overwhelmingly reuse. Mapping the agent-wrapper case onto the existing
invariant taxonomy (boundary.py `FailureMode`):

| Failure mode | Fix primitive (otel/adapter.py) | Meaning for an `agent_call` |
|---|---|---|
| `untraced`    | `trace_boundary` → `gigaphone_trace` decorator | wrapper has no span → wrap it (the **floor**, always achievable) |
| `lossy_output`| `map_output` → `gigaphone_complete`            | response carries only the truncated final string, not the full result/events |
| `off_context` | `restore_context` → `gigaphone_propagate`      | wrapper dispatched from a pool/executor → orphan off the **user's** root |

**The only genuinely new surface is discovery.** A `httpx.post(.../api/conversations)` is
invisible to every current anchor (no gateway class, no exec sink, no dispatch dict). We
need a *recognition seed* that says "this call dispatches to a sub-agent."

### The finite-anchor principle (why a catalog, not heuristics)

Discovery anchors must be **finite and recognizable**. Tools are not — any function can be
a tool — so tools are never a *seed*; they are *derived* from their structural relation to
a seed. The same applies here:

- **Seed family A — LLM SDKs** (existing): gateway/provider call sites.
- **Seed family B — Agent SDKs** (new): a finite, enumerable set of frameworks
  (langgraph, crewai, openai-agents, autogen, llamaindex, openhands-sdk, pydantic-ai,
  smolagents, …). Expressed as **data**, not code.

## Mechanism

### 1. `BoundaryKind.AGENT_CALL`

Add to `core/boundary.py`. A distinct kind (not literally `tool_exec`) earns its keep on
three counts: a different anchor catalog, a span that should *read* as an agent (span
`kind="agent"`, not `"tool"`), and different complete-output fields (agent
result/events/usage vs stdout/stderr/exit_code).

### 2. Agent-SDK catalog (data)

A shipped catalog file (e.g. `packs/python/agent_sdks.yaml`) of known dispatch signatures.
Each entry maps to the existing `Descriptor` shape:

```yaml
agent_sdks:
  - id: langgraph
    framework: langgraph
    calls: ["*.invoke", "*.ainvoke", "*.stream"]   # dotted-suffix match on the call site
    input: state
    output: [messages]
    emit: "{proj}.subagent.langgraph"
  - id: openai-agents
    framework: openai-agents
    calls: ["Runner.run", "Runner.run_sync"]
    output: [final_output]
  - id: openhands-sdk
    framework: openhands-sdk
    # recognized by constructing openhands.sdk.Agent flowing into an outbound carrier
    constructs: ["openhands.sdk.Agent", "StartConversationRequest"]
    carriers: ["httpx.*.post", "requests.post"]
    output: [events, final_message]
```

Two recognition shapes: a direct **call** signature (`Runner.run`) and a
**construct-flows-into-carrier** signature (an `Agent` object serialized into an outbound
HTTP call — the OpenHands shape). Both resolve to: the **enclosing user function** that
contains the dispatch is the `agent_call` boundary.

### 3. Discovery pass (python pack)

Add a fourth step to `PythonPack.discover`: AST-scan for catalog matches; for each, find
the enclosing `FunctionDef` and emit an `AGENT_CALL` `Descriptor` whose `match_call` is
`module.enclosing_func` (so the existing `analyze` localization — which matches a function
*defined* in the module — works unchanged). `Source.FRAMEWORK` provenance.

> Localization note: today `analyze` targets a function *defined* in the file. The agent
> dispatch is a *call site*; the boundary we trace is its **enclosing function**. Discovery
> resolves call-site → enclosing-def so Phase B stays unchanged.

### 4. Classification + fix — reused

`analyze`/`_analyze_fn` already classify untraced/lossy/off_context for a wrapper function.
`AGENT_CALL` flows through the same path as `tool_exec` (it must *not* take the `kind==LLM`
early-return). `primitive_for` emits the same decorator, with `kind="agent"` for
`AGENT_CALL`. `verify` is unchanged: span present, nested under the user's root, complete
attrs.

### 5. Resolution + contribution flywheel — reused protocol

- **Recognized** (catalog hit) → auto-propose `AGENT_CALL` descriptor.
- **Suspected but unknown** — a dispatch that *looks* agent-ish (constructs an `*Agent`
  object; POSTs to `…/conversations|runs|agents|invoke`) but matches no catalog entry →
  emit as **`unresolved`** (plan.py `Unresolved`) with a specific question
  ("Is `X` a sub-agent dispatch? input/output fields?"). The driving harness answers; the
  existing `resolve.py` ingests it (it already accepts `kind` + `boundary_call` + fields).
- **Self-serve contribution** — on a confirmed new signature: persist to the repo's
  committed `gigaphone.boundaries.yaml` (local determinism, already the pattern) **and**
  offer to upstream a catalog entry as an **OSS PR, drafted by the driving harness**
  (Claude/Codex — ADR-0006: the harness is the reasoning engine). Family B grows from real
  codebases, contributed by the agents that discovered them. The engine provides the
  catalog format + a `validate` path; the skill instructs the agent to draft + open the PR.

## Out of scope (v1)

- Context propagation into the sub-agent (traceparent injection). Owned by the sub-agent;
  not verifiable from the caller. Explicitly excluded by the ownership principle.
- TypeScript parity for the catalog/discovery — mirror later; the kind + emitter are
  language-neutral so the TS pack only needs catalog entries + a `kind="agent"` emitter.

## Verification strategy

Per ADR-0005 ("no coverage without verification") plus an **honesty gate**: an
**independent tester subagent** with *no knowledge of this implementation* installs
GigaPhone fresh from the branch and runs the documented onboarding (SKILL.md) against the
real OpenHands checkout — exactly as a new user would. Success = the
`openhands.sdk.Agent → httpx.POST` dispatch is discovered as an `agent_call` boundary and a
coherent, idempotent fix diff is produced (and synthetic fixtures verify nested+complete in
the OTel read path). The tester's ignorance keeps the result honest.

## Success criteria

1. A synthetic agent-SDK wrapper fixture: discover → plan → fix → verify yields a span that
   is nested under the user root and carries complete output attrs.
2. OpenHands: the agent dispatch is discovered as `agent_call` (not the prior false
   positives); the produced diff is reviewable and idempotent.
3. An unknown-SDK dispatch surfaces as `unresolved` with an actionable question, resolves
   via the protocol, and can be contributed back as a catalog entry.
4. Zero regressions in the existing LLM/tool_exec discovery and fix paths.
