# Design (revision): provenance-gated discovery via binding resolution

Status: approved direction (conversation), pending implementation
Date: 2026-06-26
Supersedes the discovery half of `2026-06-26-agent-call-boundary-design.md`. The boundary
kind, fix path, resolution protocol, and docs from that spec stand unchanged.
Motivation: `agent-call-why-it-breaks.html` — the honest tester showed flat name-matching
both over-fires and under-fires on real OpenHands.

## Root cause (one sentence)

Discovery flattens every call to a dotted **string** (`_attr_chain`) and matches the
**method name** (`dotted.endswith(".run")`), with no idea what object the method is called
on. So `asyncio.run` matches `llama-index` (false positive, Defect A), and a `.post` whose
payload was built in a helper can't be tied to its construct (false negative, Defect B).

Both defects are the **same gap**: no binding/dataflow resolution. The fix is one upgrade —
resolve a call's **receiver/construct to its origin package** using the import map plus
local bindings (and one hop into local helpers) — not two patches.

## The model: origin resolution with stdlib `ast`

`ast` is untyped, but origin is recoverable for the **common, locally-bound** case. Three
ingredients, all single-file, stdlib-only:

1. **Import map** (already exists: `_import_map`) → `{local_name: dotted_origin}`.
   `from langgraph.graph import StateGraph` → `{"StateGraph": "langgraph.graph.StateGraph"}`;
   `import asyncio` → `{"asyncio": "asyncio"}`.

2. **Local bindings** (new, per function): walk `Assign` nodes, map `var → origin(value)`.
   `graph = StateGraph(...).compile()` → `graph` origin = langgraph (method-chain root).

3. **`origin(expr)`** (new): `Name` → local binds, else import map, else `None`;
   `Call(func)` → `origin(func)` (a constructor's origin is its callee's);
   `Attribute(value,attr)` → `origin(value)` (resolve the root, then the chain).
   `root_package(origin) = origin.split(".")[0]`.

### Catalog gains a `packages` field

Each `AgentSdk` declares the import package(s) that identify it:

```python
AgentSdk("langgraph",     "langgraph",     calls=(".invoke",".ainvoke",".stream"), packages=("langgraph",))
AgentSdk("openai-agents", "openai-agents", calls=("Runner.run","Runner.run_sync"),  packages=("agents",))
AgentSdk("crewai",        "crewai",        calls=(".kickoff",".kickoff_async"),     packages=("crewai",))
AgentSdk("llama-index",   "llama-index",   calls=(".achat",".run"),                 packages=("llama_index",))
AgentSdk("autogen",       "autogen",       calls=(".initiate_chat",".run"),         packages=("autogen","autogen_agentchat"))
AgentSdk("openhands-sdk", "openhands-sdk", constructs=("Agent","StartConversationRequest"),
                                           carriers=(".post",), packages=("openhands",))
```

The method names (`run`, `invoke`, …) stay, but they now only fire **when paired with a
resolved package**. Bareness is no longer dangerous because provenance gates it.

## Direct-call match — provenance-gated (fixes Defect A)

For a method call `recv.method(...)`:

1. `pkg = root_package(origin(recv))`.
2. Match the catalog entry where `pkg ∈ entry.packages` **and** `method` ∈ the entry's
   method names (the trailing attr of each `calls` signature).
3. If `recv` is unresolvable (a parameter, a cross-module attribute like `self.client`,
   a helper return) → **no match here**; it degrades to the resolution protocol, never a
   silent guess.

Worked:
- `Runner.run` with `from agents import Runner` → `origin(Runner)=agents.Runner`, pkg
  `agents` ∈ openai-agents.packages, method `run` ∈ its methods → **match ✓**.
- `asyncio.run(coro)` → pkg `asyncio` ∈ no entry → **reject ✓** (kills the async_utils /
  start_sandbox false positives).
- `graph.invoke(x)` with `graph = StateGraph(...).compile()` → pkg `langgraph` → **match ✓**.

## Construct→carrier — provenance + one hop (fixes Defect B)

A function is an `agent_call` boundary when it contains a **carrier** (`.post`) and a
**construct** of a catalogued symbol **with matching provenance** — where the construct may
live one call-hop away in a locally-defined helper:

1. Collect carriers in `fn` (calls whose method ∈ `carriers`).
2. Collect constructs in `fn` **and** in any local helper `fn` calls (one hop): a call to a
   symbol `S` where `S` ∈ `entry.constructs` and `root_package(origin(S)) ∈ entry.packages`.
3. Match `entry` iff it has a carrier **and** a provenance-resolved construct.

Worked (OpenHands, same file `live_status_app_conversation_service.py`):
- `_start_app_conversation` (l.460): has `.post(.../api/conversations)` carrier; calls the
  local helper `_build_start_conversation_request_for_user` (l.1511).
- one hop into that helper: constructs `StartConversationRequest(Agent(...))`; both resolve
  to package `openhands` → construct ✓.
- carrier ✓ + construct ✓ → **the dispatch is discovered ✓** (previously missed).

The construct's provenance (not the generic `.post`) is what disambiguates, so an arbitrary
`Agent` + `.post` in unrelated code still won't match unless `Agent` resolves to `openhands`.

## Honest limits (kept explicit)

Resolution is a **strong heuristic, not sound type inference** (that needs jedi/pyright =
heavy deps, banned by ADR-0007). It resolves locally-bound receivers and one helper hop.
It does **not** resolve: a receiver passed as a parameter, returned from a non-local
helper, or read off `self`/an attribute set in another file. Those don't silently match —
they fall to the resolution protocol. Honest under-coverage beats confident wrong answers.

## Test-fixture consequence

Provenance means a discovery fixture must **import from a package the catalog recognizes** —
the Task 5 e2e fixture's fake `wrapper.subagent_sdk` import would no longer resolve. The
e2e fixture is reworked to **simulate a real catalogued framework** (openai-agents): a local
`agents` package (the black-box sub-agent SDK) plus a `harness` package whose
`run_subagent` does `Runner.run(...)`. Discovery scoped to `harness/` resolves
`Runner → agents` → match; the sub-agent SDK (`agents/`) is never instrumented (black box).
The inline discovery unit tests already import realistic packages (`from agents import
Runner`, `from openhands.sdk import Agent`) and stay valid.

## Verification

Re-run the **same honest gate**: an implementation-blind tester installs the branch fresh
and runs `discover` against real OpenHands. Pass = the agent-server dispatch
(`live_status_app_conversation_service.py` POST) is discovered as `agent_call`, **and** the
prior false positives (`async_utils.run`, `call_async_from_sync`, `start_sandbox`,
`get_docker_client`, `is_valid_git_branch_name`) are gone.

## Success criteria

1. `asyncio.run` / `subprocess.run` / other incidental `.run` calls do **not** produce
   `agent_call` boundaries (unit test).
2. The OpenHands construct-in-helper / carrier-in-poster shape **is** discovered (unit test
   with that exact split shape).
3. The reworked e2e: discover → fix → verify stays red→green→idempotent.
4. Honest tester on real OpenHands: dispatch found, zero false positives.
5. No regression in the LLM/tool_exec discovery and fix paths.
