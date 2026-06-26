# Provenance-Gated Discovery (Binding Resolution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace flat method-name matching in agent-SDK discovery with provenance resolution — resolve a call's receiver/construct to its origin package via the import map + local bindings (+ one helper hop) — fixing both the false positives (Defect A) and the missed OpenHands dispatch (Defect B).

**Architecture:** One upgrade, not two patches. A small stdlib-`ast` origin resolver (`_origin`/`_root_pkg`/`_local_binds`) feeds provenance-gated direct-call and construct→carrier matchers. The catalog gains a `packages` field so a method/construct only matches when its receiver/symbol resolves to that SDK's package. Anything unresolvable degrades to the resolution protocol — never a silent guess.

**Tech Stack:** Python 3.9+, stdlib `ast` only, zero deps. pytest.

## Global Constraints

- Zero third-party deps in `src/gigaphone/**` — stdlib only (ADR-0007).
- Python 3.9+: no `enum.StrEnum`, no `zip(strict=)`, `from __future__ import annotations` everywhere.
- No coverage claim without `verify`; every fix keeps its RED fixture (golden principle 5).
- Codemods idempotent/tagged; re-running `fix` changes nothing.
- Provenance is a heuristic, not type inference: resolve locally-bound receivers + one helper hop; unresolved receivers must NOT match (fall to resolution protocol), never silently match.
- The agent discovery pass MUST consider private methods (real dispatches like `_start_app_conversation` are private) — do not skip leading-underscore names in the agent pass.
- Existing LLM/tool_exec discovery + the e2e_onboarding suite must stay green.
- Design: `docs/specs/2026-06-26-agent-call-binding-resolution.md`.

## Test command (worktree has no venv)
`PYTHONPATH=/Users/jamesgao/Projects/gigaphone/.claude/worktrees/agent-call-boundary/src /Users/jamesgao/Projects/gigaphone/.venv/bin/python -m pytest <args>`

---

## File Structure

- Modify `src/gigaphone/packs/python/agent_sdks.py` — add `packages`; add `methods`, `match_package_method`, `match_construct`, `carrier_methods`; remove the bare `match_call_site`.
- Modify `src/gigaphone/packs/python/pack.py` — add `_origin`/`_root_pkg`/`_local_binds`; rewrite the agent discovery pass (`_match_direct`, `_match_construct_carrier`) provenance-gated; include private methods in the agent pass.
- Modify `tests/test_agent_call.py` — update catalog test; add provenance unit tests (positive + negative).
- Rework `testclient/wrapper/**` → `testclient/agent_wrapper/**` (simulate a real catalogued framework) and `tests/test_e2e_agent_wrapper.py`.

---

### Task R1: Catalog gains `packages` + provenance lookups

**Files:** Modify `src/gigaphone/packs/python/agent_sdks.py`; Modify `tests/test_agent_call.py`.

**Interfaces produced:**
- `AgentSdk` gains `packages: tuple[str, ...]`.
- `methods(sdk) -> set[str]` — trailing attr of each `calls` sig (`.invoke`→`invoke`, `Runner.run`→`run`).
- `match_package_method(pkg, method) -> AgentSdk | None`.
- `match_construct(symbol, pkg) -> AgentSdk | None`.
- `carrier_methods() -> set[str]` — trailing attr of every entry's `carriers`.
- `match_call_site` is REMOVED.

- [ ] **Step 1: Write the failing tests** — replace the existing `test_catalog_recognizes_known_call_signatures` and `test_catalog_entry_formatter_round_trips_shape` block in `tests/test_agent_call.py` with:

```python
from gigaphone.packs.python import agent_sdks


def test_catalog_matches_method_only_with_package_provenance():
    # openai-agents owns package "agents"; "run" is one of its methods
    assert agent_sdks.match_package_method("agents", "run").framework == "openai-agents"
    # the SAME method name on a non-framework package must NOT match (kills asyncio.run, etc.)
    assert agent_sdks.match_package_method("asyncio", "run") is None
    # langgraph .invoke
    assert agent_sdks.match_package_method("langgraph", "invoke").framework == "langgraph"


def test_catalog_matches_construct_with_package_provenance():
    assert agent_sdks.match_construct("StartConversationRequest", "openhands").framework == "openhands-sdk"
    assert agent_sdks.match_construct("Agent", "openhands").framework == "openhands-sdk"
    # an Agent class from some other package must not match openhands-sdk
    assert agent_sdks.match_construct("Agent", "langchain") is None


def test_carrier_methods_exposed():
    assert "post" in agent_sdks.carrier_methods()


def test_catalog_entry_formatter_round_trips_shape():
    block = agent_sdks.format_entry(
        "acme-agents", "acme-agents", calls=("AcmeRunner.run",), output_fields=("final",)
    )
    assert "AcmeRunner.run" in block and "acme-agents" in block
```

- [ ] **Step 2: Run → fail**

Run: `tests/test_agent_call.py -k "catalog or carrier" -v`
Expected: FAIL — `match_package_method` / `match_construct` / `carrier_methods` undefined.

- [ ] **Step 3: Implement** — in `src/gigaphone/packs/python/agent_sdks.py`, add `packages` to the dataclass and every entry, delete `match_call_site`, and add the lookups:

```python
@dataclass(frozen=True)
class AgentSdk:
    id: str
    framework: str
    calls: tuple[str, ...] = ()
    constructs: tuple[str, ...] = ()
    carriers: tuple[str, ...] = ()
    packages: tuple[str, ...] = ()
    input_arg: str | None = None
    output_fields: tuple[str, ...] = ()


AGENT_SDKS: tuple[AgentSdk, ...] = (
    AgentSdk("langgraph", "langgraph", calls=(".invoke", ".ainvoke", ".stream"),
             packages=("langgraph",), input_arg="input", output_fields=("messages",)),
    AgentSdk("openai-agents", "openai-agents", calls=("Runner.run", "Runner.run_sync"),
             packages=("agents",), output_fields=("final_output",)),
    AgentSdk("crewai", "crewai", calls=(".kickoff", ".kickoff_async"),
             packages=("crewai",), output_fields=("raw", "tasks_output")),
    AgentSdk("llama-index", "llama-index", calls=(".achat", ".run"),
             packages=("llama_index",), output_fields=("response",)),
    AgentSdk("autogen", "autogen", calls=(".initiate_chat", ".run"),
             packages=("autogen", "autogen_agentchat"), output_fields=("summary", "chat_history")),
    AgentSdk("openhands-sdk", "openhands-sdk", constructs=("Agent", "StartConversationRequest"),
             carriers=(".post",), packages=("openhands",),
             output_fields=("events", "final_message")),
)


def methods(sdk: AgentSdk) -> set:
    return {sig.rsplit(".", 1)[-1] for sig in sdk.calls}


def match_package_method(pkg: str, method: str):
    if not pkg:
        return None
    for sdk in AGENT_SDKS:
        if pkg in sdk.packages and method in methods(sdk):
            return sdk
    return None


def match_construct(symbol: str, pkg: str):
    if not pkg:
        return None
    for sdk in AGENT_SDKS:
        if symbol in sdk.constructs and pkg in sdk.packages:
            return sdk
    return None


def carrier_methods() -> set:
    out: set = set()
    for sdk in AGENT_SDKS:
        out |= {c.rsplit(".", 1)[-1] for c in sdk.carriers}
    return out
```

Keep `format_entry` (extend it to accept `packages` similarly to the other tuple fields).

- [ ] **Step 4: Run → pass**; then full suite. (Discovery in `pack.py` still references the old `match_call_site` — it will be rewritten in R2/R3; until then the agent discovery tests from the prior plan may fail. That is expected and fixed in R2/R3. Run `tests/test_agent_call.py -k "catalog or carrier"` to confirm THIS task, and proceed — do not chase the discovery tests yet.)

- [ ] **Step 5: Commit**

```bash
git add src/gigaphone/packs/python/agent_sdks.py tests/test_agent_call.py
git commit -m "feat(catalog): add package provenance + method/construct lookups; drop bare name match"
```

---

### Task R2: Origin resolver + provenance-gated direct-call discovery

**Files:** Modify `src/gigaphone/packs/python/pack.py`; Modify `tests/test_agent_call.py`.

**Interfaces produced (module-level in pack.py):**
- `_origin(expr, binds: dict, imports: dict) -> str | None`
- `_root_pkg(origin: str | None) -> str | None`
- `_local_binds(fn, imports: dict) -> dict` (var → origin)
- `_match_direct(fn, imports) -> AgentSdk | None`
- The agent discovery pass now passes `imports`/`funcs` and considers private methods.

- [ ] **Step 1: Write failing tests (append to `tests/test_agent_call.py`)**

```python
def _discover_src(tmp_path, name, src):
    (tmp_path / name).write_text(src)
    return _discover.discover(str(tmp_path))


def test_direct_call_matches_only_with_provenance(tmp_path):
    descs = _discover_src(
        tmp_path, "h.py",
        "from __future__ import annotations\n"
        "from agents import Runner\n\n"
        "def run_subagent(task):\n"
        "    return Runner.run(task)\n",
    )
    agent = next((d for d in descs if d.kind.value == "agent_call"), None)
    assert agent is not None and agent.match_call == "h.run_subagent"
    assert agent.emit_name == "h.subagent.openai-agents"


def test_incidental_run_call_is_not_an_agent_boundary(tmp_path):
    # asyncio.run / a plain .run on a non-framework object must NOT match (Defect A)
    descs = _discover_src(
        tmp_path, "u.py",
        "from __future__ import annotations\n"
        "import asyncio\n\n"
        "def call_async_from_sync(coro):\n"
        "    return asyncio.run(coro)\n",
    )
    assert not any(d.kind.value == "agent_call" for d in descs)


def test_locally_constructed_receiver_resolves(tmp_path):
    descs = _discover_src(
        tmp_path, "g.py",
        "from __future__ import annotations\n"
        "from langgraph.graph import StateGraph\n\n"
        "def run_graph(state):\n"
        "    graph = StateGraph(state).compile()\n"
        "    return graph.invoke(state)\n",
    )
    assert any(d.kind.value == "agent_call" and d.match_call == "g.run_graph" for d in descs)


def test_unresolvable_param_receiver_does_not_match(tmp_path):
    descs = _discover_src(
        tmp_path, "p.py",
        "from __future__ import annotations\n\n"
        "def run_graph(graph, state):\n"   # graph is a param: origin unknown
        "    return graph.invoke(state)\n",
    )
    assert not any(d.kind.value == "agent_call" for d in descs)
```

- [ ] **Step 2: Run → fail** (`-k "provenance or incidental_run or locally_constructed or unresolvable_param"`).

- [ ] **Step 3: Implement the resolver + direct matcher** in `src/gigaphone/packs/python/pack.py`. Add module-level helpers:

```python
def _origin(expr, binds: dict, imports: dict):
    """Best-effort origin (dotted) of an expression, stdlib-ast only."""
    if isinstance(expr, ast.Name):
        return binds.get(expr.id) or imports.get(expr.id)
    if isinstance(expr, ast.Call):
        return _origin(expr.func, binds, imports)
    if isinstance(expr, ast.Attribute):
        base = _origin(expr.value, binds, imports)
        return f"{base}.{expr.attr}" if base else None
    return None


def _root_pkg(origin):
    return origin.split(".")[0] if origin else None


def _local_binds(fn, imports: dict) -> dict:
    """Map locally-assigned names to their origin (var = Constructor(...) / import alias)."""
    binds: dict = {}
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign) and isinstance(n.value, (ast.Call, ast.Name, ast.Attribute)):
            origin = _origin(n.value, binds, imports)
            if origin:
                for t in n.targets:
                    if isinstance(t, ast.Name):
                        binds[t.id] = origin
    return binds


def _match_direct(fn, imports: dict):
    """A method call whose receiver resolves to a catalogued SDK package."""
    binds = _local_binds(fn, imports)
    for n in ast.walk(fn):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
            pkg = _root_pkg(_origin(n.func.value, binds, imports))
            sdk = agent_sdks.match_package_method(pkg, n.func.attr)
            if sdk is not None:
                return sdk
    return None
```

Now rewrite discovery step 4 in `PythonPack.discover`. Replace the existing agent pass with (note: NOT skipping private names, and passing `imports`):

```python
        # 4) agent-SDK dispatch (seed family B), provenance-gated. Private methods included —
        #    real dispatches (e.g. _start_app_conversation) are private.
        for name, fn in funcs.by_name.items():
            if name.startswith("__"):
                continue
            sdk = _match_direct(fn, imports) or _match_construct_carrier(fn, imports, funcs)
            if sdk is not None and not any(d.match_call.endswith(f".{name}") for d in out):
                out.append(
                    Descriptor(
                        id=f"agent-{name}",
                        kind=BoundaryKind.AGENT_CALL,
                        match_call=f"{module}.{name}",
                        input_arg=sdk.input_arg,
                        output_paths=list(sdk.output_fields),
                        emit_name=f"{_proj(module)}.subagent.{sdk.framework}",
                    )
                )
```

For THIS task, add a temporary `_match_construct_carrier` stub returning `None` (R3 implements it) so the module imports cleanly:

```python
def _match_construct_carrier(fn, imports: dict, funcs):
    return None  # implemented in R3
```

Delete the old `_match_agent_sdk_fn` (replaced).

- [ ] **Step 4: Run → pass** (the four R2 tests). Then run `tests/test_agent_call.py -v` — the Task-3 `test_discovery_finds_direct_agent_sdk_call` should still pass (its fixture imports `from agents import Runner`). The Task-4 `test_discovery_finds_construct_then_carrier_shape` will FAIL (stub) — that is expected; R3 fixes it. Note it and proceed.

- [ ] **Step 5: Commit**

```bash
git add src/gigaphone/packs/python/pack.py tests/test_agent_call.py
git commit -m "feat(discovery): provenance-gated direct-call matching via origin resolver"
```

---

### Task R3: Construct→carrier with provenance + one helper hop

**Files:** Modify `src/gigaphone/packs/python/pack.py`; Modify `tests/test_agent_call.py`.

**Interfaces produced:** real `_match_construct_carrier(fn, imports, funcs)` — fires when `fn` has a carrier method AND a provenance-resolved construct in `fn` or one local-helper hop.

- [ ] **Step 1: Write failing tests (append)**

```python
def test_construct_carrier_same_function(tmp_path):
    descs = _discover_src(
        tmp_path, "s.py",
        "from __future__ import annotations\n"
        "from openhands.sdk import Agent\n"
        "import httpx\n\n"
        "def start(task, client):\n"
        "    agent = Agent(model='x')\n"
        "    return client.post('http://a/api/conversations', json={'a': agent})\n",
    )
    assert any(d.kind.value == "agent_call" and d.match_call == "s.start" for d in descs)


def test_construct_in_helper_carrier_in_poster_DIFFERENT_functions(tmp_path):
    # the OpenHands shape: build in a helper, POST in the (private) poster
    descs = _discover_src(
        tmp_path, "svc.py",
        "from __future__ import annotations\n"
        "from openhands.sdk import Agent\n"
        "from openhands.models import StartConversationRequest\n"
        "import httpx\n\n"
        "def _build_request(task):\n"
        "    return StartConversationRequest(agent=Agent(model='x'))\n\n"
        "async def _start_app_conversation(task, client):\n"
        "    req = _build_request(task)\n"
        "    return await client.post('http://a/api/conversations', json=req)\n",
    )
    agent = next((d for d in descs if d.kind.value == "agent_call"), None)
    assert agent is not None and agent.match_call == "svc._start_app_conversation"
    assert agent.emit_name == "svc.subagent.openhands-sdk"


def test_arbitrary_agent_plus_post_without_framework_provenance_does_not_match(tmp_path):
    descs = _discover_src(
        tmp_path, "x.py",
        "from __future__ import annotations\n"
        "from mylib import Agent\n"      # not an openhands Agent
        "import httpx\n\n"
        "def handle(client):\n"
        "    a = Agent()\n"
        "    return client.post('http://a/x', json={'a': a})\n",
    )
    assert not any(d.kind.value == "agent_call" for d in descs)
```

- [ ] **Step 2: Run → fail** (`-k "construct_carrier or DIFFERENT_functions or arbitrary_agent"`).

- [ ] **Step 3: Implement** — replace the `_match_construct_carrier` stub in `pack.py`:

```python
_CARRIER_METHODS = agent_sdks.carrier_methods()


def _has_carrier(fn) -> bool:
    for n in ast.walk(fn):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
            if n.func.attr in _CARRIER_METHODS:
                return True
    return False


def _local_helper_bodies(fn, funcs):
    """fn plus one hop into any locally-defined function fn calls."""
    bodies = [fn]
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            tail = _attr_chain(n.func).rsplit(".", 1)[-1]
            helper = funcs.by_name.get(tail)
            if helper is not None and helper is not fn:
                bodies.append(helper)
    return bodies


def _match_construct_carrier(fn, imports: dict, funcs):
    """fn carries an outbound call AND constructs a catalogued symbol (here or one hop),
    with the construct's origin resolving to that SDK's package."""
    if not _has_carrier(fn):
        return None
    for body in _local_helper_bodies(fn, funcs):
        binds = _local_binds(body, imports)
        for n in ast.walk(body):
            if isinstance(n, ast.Call):
                symbol = _attr_chain(n.func).rsplit(".", 1)[-1]
                pkg = _root_pkg(_origin(n.func, binds, imports))
                sdk = agent_sdks.match_construct(symbol, pkg)
                if sdk is not None:
                    return sdk
    return None
```

- [ ] **Step 4: Run → pass** (the three R3 tests + Task-4's original `test_discovery_finds_construct_then_carrier_shape` which now imports `openhands.sdk`). Then full suite `-q` EXCEPT the e2e wrapper (reworked in R4) — if `tests/test_e2e_agent_wrapper.py` fails because the old `testclient/wrapper` fixture uses a fake `wrapper.subagent_sdk` import, that is expected and fixed in R4. Confirm `tests/test_e2e_onboarding.py` and all `tests/test_agent_call.py` pass.

- [ ] **Step 5: Commit**

```bash
git add src/gigaphone/packs/python/pack.py tests/test_agent_call.py
git commit -m "feat(discovery): construct->carrier provenance + one helper hop (OpenHands shape)"
```

---

### Task R4: Rework the e2e fixture to simulate a real framework

**Files:** Create `testclient/agent_wrapper/**`; delete `testclient/wrapper/**`; rewrite `tests/test_e2e_agent_wrapper.py`.

**Interfaces:** the e2e proves discover→fix→verify red→green→idempotent on a fixture whose `run_subagent` calls a real-catalogued framework (`agents.Runner.run`), so provenance resolves.

- [ ] **Step 1: Create the fixture** (a fake `agents` SDK package + a `harness` package):

```python
# testclient/agent_wrapper/agents/__init__.py
"""Stand-in for the openai-agents SDK — the black box. GigaPhone instruments NOTHING here."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Result:
    final_output: str
    events: list = field(default_factory=list)


class Runner:
    @staticmethod
    def run(task: str) -> "Result":
        return Result(final_output=f"done: {task}", events=["plan", "act"])
```

```python
# testclient/agent_wrapper/harness/__init__.py
```
(empty)

```python
# testclient/agent_wrapper/harness/service.py
"""The harness wraps a whole sub-agent. `run_subagent` is the agent_call boundary —
UNTRACED before GigaPhone."""
from __future__ import annotations

from agents import Runner


def run_subagent(task: str):
    result = Runner.run(task)
    return result
```

```python
# testclient/agent_wrapper/harness/tracing.py
"""Customer observability wiring — honours $GIGAPHONE_SPAN_FILE, one JSON line per span."""
from __future__ import annotations

import json
import os

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult

_INITIALIZED = False


class _JsonlFileExporter(SpanExporter):
    def __init__(self, path: str) -> None:
        self._path = path

    def export(self, spans) -> SpanExportResult:
        with open(self._path, "a", encoding="utf-8") as fh:
            for s in spans:
                ctx = s.get_span_context()
                fh.write(
                    json.dumps(
                        {
                            "name": s.name,
                            "trace_id": format(ctx.trace_id, "032x"),
                            "span_id": format(ctx.span_id, "016x"),
                            "parent_id": (format(s.parent.span_id, "016x") if s.parent else None),
                            "attributes": {k: v for k, v in (s.attributes or {}).items()},
                        }
                    )
                    + "\n"
                )
        return SpanExportResult.SUCCESS


def init_tracing() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    provider = TracerProvider()
    span_file = os.environ.get("GIGAPHONE_SPAN_FILE")
    if span_file:
        provider.add_span_processor(SimpleSpanProcessor(_JsonlFileExporter(span_file)))
    trace.set_tracer_provider(provider)
    _INITIALIZED = True


def tracer():
    init_tracing()
    return trace.get_tracer("harness")
```

```python
# testclient/agent_wrapper/harness/run_representative.py
"""Representative path: a root `agent` span that dispatches the sub-agent once."""
from __future__ import annotations

from harness.service import run_subagent
from harness.tracing import init_tracing, tracer


def main() -> str:
    init_tracing()
    with tracer().start_as_current_span("agent") as span:
        span.set_attribute("agent.task", "delegate")
        result = run_subagent("summarize the repo")
        span.set_attribute("agent.final", result.final_output)
        return result.final_output


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Delete the old fixture**

```bash
git rm -r testclient/wrapper
```

- [ ] **Step 3: Rewrite the e2e test**

```python
# tests/test_e2e_agent_wrapper.py
"""E2E: a harness wrapping a whole sub-agent (simulated openai-agents). The agent_call
boundary is UNTRACED before GigaPhone and traced + complete + nested after."""
from __future__ import annotations

import os
import shutil

import pytest

from gigaphone import config
from gigaphone.adapters.backend.otel import OtelAdapter
from gigaphone.core.boundary import BoundaryKind, FailureMode
from gigaphone.engine import detect as _detect
from gigaphone.engine import discover as _discover
from gigaphone.engine import fix as _fix
from gigaphone.engine import verify as _verify

_TESTCLIENT = os.path.join(os.path.dirname(__file__), "..", "testclient", "agent_wrapper")


@pytest.fixture
def repo(tmp_path):
    shutil.copytree(_TESTCLIENT, tmp_path / "agent_wrapper")
    return str(tmp_path / "agent_wrapper")


def test_agent_wrapper_red_then_green_then_idempotent(repo):
    backend = OtelAdapter()
    descs = _discover.discover(repo, "harness")
    agent = next((d for d in descs if d.kind == BoundaryKind.AGENT_CALL), None)
    assert agent is not None and agent.match_call == "harness.service.run_subagent"

    config.save(repo, descs)
    boundaries = _detect.detect(repo, descs, "harness")
    run_b = next(b for b in boundaries if b.func_name == "run_subagent")
    assert run_b.failure_modes == [FailureMode.UNTRACED]

    expectations = [backend.expectation_for(b) for b in boundaries if b.failure_modes]

    before = _verify.verify(repo, expectations, backend, module="harness.run_representative")
    assert not all(v.ok for v in before)

    result = _fix.apply_fixes(repo, boundaries, backend)
    assert result.diffs

    after = _verify.verify(repo, expectations, backend, module="harness.run_representative")
    assert all(v.ok for v in after), [(v.tool, v.detail) for v in after]

    src = open(os.path.join(repo, "harness", "service.py"), encoding="utf-8").read()
    assert 'kind="agent"' in src

    boundaries2 = _detect.detect(repo, descs, "harness")
    rerun = _fix.apply_fixes(repo, boundaries2, backend)
    assert not rerun.diffs
```

Note: discovery is scoped to `harness` so the fake `agents` SDK package is NOT scanned (it is the black box). `repo` is the `agent_wrapper` dir so both `harness` and `agents` are importable by the representative path.

- [ ] **Step 4: Run → pass** (`tests/test_e2e_agent_wrapper.py -v`), then full suite `-q` (expect all green).

- [ ] **Step 5: Commit**

```bash
git add testclient/agent_wrapper tests/test_e2e_agent_wrapper.py
git add -A testclient/wrapper
git commit -m "test(e2e): simulate a real framework so provenance discovery fires end-to-end"
```

---

### Task R5: Honesty gate — re-run the implementation-blind tester vs OpenHands

**Files:** none (verification). Dispatch a fresh tester that has NOT seen this plan.

- [ ] **Step 1:** Dispatch the same tester brief used before (implementation-blind: do NOT read gigaphone src/tests; run `discover` against `/Users/jamesgao/Projects/OpenHands/.claude/worktrees/gigaphone-instrument` scoped to `openhands/app_server/app_conversation`, then wider). Report the produced `gigaphone.boundaries.yaml`.

- [ ] **Step 2: Evaluate against success criteria:**
  - PASS if the agent-server dispatch in `live_status_app_conversation_service.py` is discovered as `agent_call`, AND the prior false positives (`async_utils.run`, `call_async_from_sync`, `start_sandbox`, `get_docker_client`, `is_valid_git_branch_name`) are GONE.
  - If the dispatch is still missed: capture exactly why (e.g. the build helper is in a different module than the POST, beyond one-hop same-file resolution) and report it honestly — do not claim success.

- [ ] **Step 3:** Record the verdict in the progress ledger and (when opening the PR) the PR body.

---

## Self-Review

- Defect A (false positives) → R2 (provenance gate) + `test_incidental_run_call_is_not_an_agent_boundary`. ✓
- Defect B (missed dispatch) → R3 (construct→carrier one hop) + `test_construct_in_helper_carrier_in_poster_DIFFERENT_functions`. ✓
- Private-method dispatch included → R2 step 3 (`startswith("__")` only). ✓
- Honest under-coverage (unresolved → no silent match) → `test_unresolvable_param_receiver_does_not_match`. ✓
- Fixture provenance consequence → R4 (simulate real framework). ✓
- Re-verify on real OpenHands → R5. ✓
- Type consistency: `match_package_method(pkg, method)`, `match_construct(symbol, pkg)`, `carrier_methods()`, `_origin/_root_pkg/_local_binds/_match_direct/_match_construct_carrier` used identically across R1–R3. ✓
- Placeholder scan: every code step is complete; the R2 `_match_construct_carrier` stub is explicitly replaced in R3. ✓
