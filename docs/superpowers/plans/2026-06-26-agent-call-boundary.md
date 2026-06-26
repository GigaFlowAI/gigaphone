# agent_call Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agent_call` boundary kind so GigaPhone can instrument harnesses that wrap a whole sub-agent (e.g. OpenHands → remote agent-server), where there is no in-process LLM call to anchor on.

**Architecture:** A sub-agent is a black box *by ownership* — wrap the harness's own boundary, never reach inside. Reuse the existing `untraced`/`lossy_output`/`off_context` taxonomy and fix primitives wholesale; the one new surface is **discovery**, via a data-driven Agent-SDK catalog (seed family B) plus a pass that localizes the *enclosing* function of a catalog-matched call. Unknowns flow through the existing resolution protocol; confirmed signatures contribute back as catalog entries.

**Tech Stack:** Python 3.9+, stdlib `ast` only (ADR-0007), zero runtime dependencies (the engine runs on a bare `python3`). Tests use `pytest`. OTel test backend writes spans as JSONL.

## Global Constraints

- Zero third-party dependencies in `src/gigaphone/**` — stdlib only (ADR-0007, commit #4 "Zero-dependency plugin").
- Python 3.9+ compatibility: no `enum.StrEnum`, no `zip(strict=)`, `from __future__ import annotations` in every module.
- No coverage claim without `verify` (ADR-0005). Every fix has a RED fixture first (golden principle 5).
- Codemods are idempotent and tagged (`gigaphone:<op>:<func>`); re-running `fix` must change nothing.
- The engine never calls a model (ADR-0006); the harness is the reasoning engine for discovery/resolution.
- Boundary vocabulary names no harness/vendor/codebase (DESIGN §10).
- Spec: `docs/specs/2026-06-26-agent-call-boundary-design.md`.

---

## File Structure

- Modify `src/gigaphone/core/boundary.py` — add `BoundaryKind.AGENT_CALL`.
- Create `src/gigaphone/packs/python/agent_sdks.py` — the Agent-SDK catalog (data) + match helpers + entry formatter.
- Modify `src/gigaphone/packs/python/pack.py` — discovery step 4 (catalog) and `_analyze_fn` generalization to treat `AGENT_CALL` like `TOOL_EXEC`.
- Modify `src/gigaphone/adapters/backend/otel/adapter.py` — emit span `kind="agent"` for `AGENT_CALL`.
- Modify `src/gigaphone/engine/plan.py` — agent-aware wording for an unresolved `agent_call`.
- Create `testclient/wrapper/**` — agent-wrapper fixture (sub-agent SDK black box + harness + tracing + representative path).
- Create `tests/test_agent_call.py` — kind/analyze/discovery/resolution/catalog unit tests.
- Create `tests/test_e2e_agent_wrapper.py` — red → green → idempotent e2e for the wrapper.
- Create `docs/adr/0008-agent-call-boundary.md`; modify `docs/DESIGN.md` (§8.4 kinds) and `skills/gigaphone/SKILL.md` (golden-rule row + suspect/contribution steps).

---

### Task 1: Add `AGENT_CALL` kind and route it through the tool_exec fix path

**Files:**
- Modify: `src/gigaphone/core/boundary.py:21-26`
- Modify: `src/gigaphone/packs/python/pack.py:186,193` (inside `_analyze_fn`)
- Modify: `src/gigaphone/adapters/backend/otel/adapter.py:17,65-68` (`primitive_for` UNTRACED branch)
- Test: `tests/test_agent_call.py`

**Interfaces:**
- Produces: `BoundaryKind.AGENT_CALL` (value `"agent_call"`); an `AGENT_CALL` boundary classifies and fixes exactly like `TOOL_EXEC` but its UNTRACED decorator emits `kind="agent"`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_agent_call.py
"""agent_call boundary: kind, localization, discovery, resolution, catalog (DESIGN §8.4)."""
from __future__ import annotations

from gigaphone.adapters.backend.otel import OtelAdapter
from gigaphone.core.boundary import BoundaryKind, FailureMode
from gigaphone.core.model import Boundary, Descriptor, Range
from gigaphone.packs.python.pack import PythonPack

_WRAPPER_SRC = '''\
from __future__ import annotations
from subagent_sdk import Runner

def run_subagent(task: str):
    result = Runner.run(task)
    return result
'''


def test_agent_call_kind_value():
    assert BoundaryKind.AGENT_CALL.value == "agent_call"


def test_agent_call_descriptor_localizes_as_untraced_with_agent_emit():
    pack = PythonPack()
    desc = Descriptor(
        id="agent-run_subagent",
        kind=BoundaryKind.AGENT_CALL,
        match_call="harness.run_subagent",
        emit_name="harness.subagent.openai-agents",
    )
    boundaries = pack.analyze("harness.py", _WRAPPER_SRC, [desc])
    assert len(boundaries) == 1
    b = boundaries[0]
    assert b.kind == BoundaryKind.AGENT_CALL
    assert b.failure_modes == [FailureMode.UNTRACED]
    assert b.tools_covered == ["run_subagent"]

    # the UNTRACED fix decorator must declare the span kind as "agent", not "tool"
    prim = OtelAdapter().primitive_for(b, FailureMode.UNTRACED)
    assert 'kind="agent"' in prim.decorator
    assert prim.emit_name == "harness.subagent.openai-agents"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_agent_call.py -v`
Expected: FAIL — `AttributeError: AGENT_CALL` (the enum member does not exist yet).

- [ ] **Step 3: Add the enum member**

In `src/gigaphone/core/boundary.py`, inside `class BoundaryKind`, after the `TOOL_RESULT_SINK` line:

```python
    TOOL_RESULT_SINK = "tool_result_sink"  # where the result is written back into the message list
    AGENT_CALL = "agent_call"  # a call that dispatches a whole sub-agent (black box by ownership)
```

- [ ] **Step 4: Generalize `_analyze_fn` to treat `AGENT_CALL` like `TOOL_EXEC`**

In `src/gigaphone/packs/python/pack.py`, in `_analyze_fn`, change the two `TOOL_EXEC`-only lines:

```python
            tools_covered=[d.id.replace("tool-", "")] if d.kind == BoundaryKind.TOOL_EXEC else [],
```
to
```python
            tools_covered=(
                [d.id.split("-", 1)[-1]]
                if d.kind in (BoundaryKind.TOOL_EXEC, BoundaryKind.AGENT_CALL)
                else []
            ),
```
and
```python
        if not b.complete_output_fields and d.kind == BoundaryKind.TOOL_EXEC:
```
to
```python
        if not b.complete_output_fields and d.kind in (
            BoundaryKind.TOOL_EXEC,
            BoundaryKind.AGENT_CALL,
        ):
```

(The `if d.kind == BoundaryKind.LLM:` early-return is unchanged — `AGENT_CALL` correctly falls through to the untraced/lossy/off_context classifier.)

- [ ] **Step 5: Emit `kind="agent"` for `AGENT_CALL` in the OTel UNTRACED primitive**

In `src/gigaphone/adapters/backend/otel/adapter.py`, update the import on line 17:

```python
from gigaphone.core.boundary import BoundaryKind, FailureMode
```

Then in `primitive_for`, the `UNTRACED` branch, replace the decorator construction:

```python
        if mode == FailureMode.UNTRACED:
            name = boundary.emit_name or f"{boundary.provider_or_framework}.{boundary.func_name}"
            fields = ", ".join(repr(f) for f in boundary.complete_output_fields)
            span_kind = "agent" if boundary.kind == BoundaryKind.AGENT_CALL else "tool"
            decorator = f'gigaphone_trace(name="{name}", kind="{span_kind}", output=[{fields}])'
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_agent_call.py -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `python3 -m pytest -q`
Expected: PASS (all pre-existing tests still green).

- [ ] **Step 8: Commit**

```bash
git add src/gigaphone/core/boundary.py src/gigaphone/packs/python/pack.py \
        src/gigaphone/adapters/backend/otel/adapter.py tests/test_agent_call.py
git commit -m "feat(core): add agent_call boundary kind, routed through the tool_exec fix path"
```

---

### Task 2: Agent-SDK catalog (seed family B) as data

**Files:**
- Create: `src/gigaphone/packs/python/agent_sdks.py`
- Test: `tests/test_agent_call.py` (append)

**Interfaces:**
- Produces:
  - `AgentSdk` dataclass: `id, framework, calls: tuple[str,...], constructs: tuple[str,...], carriers: tuple[str,...], input_arg: str|None, output_fields: tuple[str,...]`.
  - `AGENT_SDKS: tuple[AgentSdk, ...]` — the shipped catalog.
  - `match_call_site(dotted: str) -> AgentSdk | None` — suffix-match a call's dotted name against any entry's `calls`.
  - `format_entry(id, framework, *, calls=(), constructs=(), carriers=(), input_arg=None, output_fields=()) -> str` — render a catalog-entry source block for contribution.

- [ ] **Step 1: Write the failing test (append to `tests/test_agent_call.py`)**

```python
from gigaphone.packs.python import agent_sdks


def test_catalog_recognizes_known_call_signatures():
    # langgraph-style: a `.invoke` suffix; openai-agents: `Runner.run`
    assert agent_sdks.match_call_site("graph.invoke").framework == "langgraph"
    assert agent_sdks.match_call_site("Runner.run").framework == "openai-agents"
    # a plain method named invoke on an llm client must NOT be force-matched by exact name only
    assert agent_sdks.match_call_site("os.path.join") is None


def test_catalog_entry_formatter_round_trips_shape():
    block = agent_sdks.format_entry(
        "acme-agents", "acme-agents", calls=("AcmeRunner.run",), output_fields=("final",)
    )
    assert "AcmeRunner.run" in block
    assert "acme-agents" in block
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_agent_call.py -k catalog -v`
Expected: FAIL — `ModuleNotFoundError: gigaphone.packs.python.agent_sdks`.

- [ ] **Step 3: Create the catalog module**

```python
# src/gigaphone/packs/python/agent_sdks.py
"""Agent-SDK catalog — seed family B (DESIGN §8.4; spec 2026-06-26).

Finite, enumerable signatures for frameworks that dispatch a whole sub-agent. Data, not
heuristics: tools can be any function and so are never seeded, but agent SDKs are a closed
set. Contributors add entries here (or via the resolution protocol's contribution step).
The sub-agent itself is a black box by ownership — we recognize the *dispatch*, never its
internals.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AgentSdk:
    id: str
    framework: str
    calls: tuple[str, ...] = ()  # dotted-suffix call signatures, e.g. "Runner.run", ".invoke"
    constructs: tuple[str, ...] = ()  # constructed symbols that signal an agent, e.g. "Agent"
    carriers: tuple[str, ...] = ()  # outbound carriers paired with a construct, e.g. ".post"
    input_arg: str | None = None
    output_fields: tuple[str, ...] = field(default_factory=tuple)


AGENT_SDKS: tuple[AgentSdk, ...] = (
    AgentSdk("langgraph", "langgraph", calls=(".invoke", ".ainvoke", ".stream"),
             input_arg="input", output_fields=("messages",)),
    AgentSdk("openai-agents", "openai-agents", calls=("Runner.run", "Runner.run_sync"),
             output_fields=("final_output",)),
    AgentSdk("crewai", "crewai", calls=(".kickoff", ".kickoff_async"),
             output_fields=("raw", "tasks_output")),
    AgentSdk("llama-index", "llama-index", calls=(".achat", ".run"),
             output_fields=("response",)),
    AgentSdk("autogen", "autogen", calls=(".initiate_chat", ".run"),
             output_fields=("summary", "chat_history")),
    # OpenHands: an Agent config is constructed and handed to an outbound HTTP carrier.
    AgentSdk("openhands-sdk", "openhands-sdk",
             constructs=("Agent", "StartConversationRequest"),
             carriers=(".post",), output_fields=("events", "final_message")),
)


def match_call_site(dotted: str) -> AgentSdk | None:
    """Return the catalog entry whose `calls` signature matches this call's dotted name.

    A signature starting with "." matches on the trailing attribute (`graph.invoke` →
    ".invoke"); otherwise it must be a dotted suffix (`Runner.run`)."""
    for sdk in AGENT_SDKS:
        for sig in sdk.calls:
            if sig.startswith("."):
                if dotted.endswith(sig) and dotted != sig.lstrip("."):
                    return sdk
            elif dotted == sig or dotted.endswith("." + sig):
                return sdk
    return None


def format_entry(
    id: str,
    framework: str,
    *,
    calls: tuple[str, ...] = (),
    constructs: tuple[str, ...] = (),
    carriers: tuple[str, ...] = (),
    input_arg: str | None = None,
    output_fields: tuple[str, ...] = (),
) -> str:
    """Render a catalog-entry source block an OSS contributor (or the driving harness) can
    paste into AGENT_SDKS."""
    parts = [f'AgentSdk("{id}", "{framework}"']
    if calls:
        parts.append(f"calls={calls!r}")
    if constructs:
        parts.append(f"constructs={constructs!r}")
    if carriers:
        parts.append(f"carriers={carriers!r}")
    if input_arg:
        parts.append(f"input_arg={input_arg!r}")
    if output_fields:
        parts.append(f"output_fields={output_fields!r}")
    return ", ".join(parts) + "),"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_agent_call.py -k catalog -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gigaphone/packs/python/agent_sdks.py tests/test_agent_call.py
git commit -m "feat(packs): add Agent-SDK catalog (seed family B) as data"
```

---

### Task 3: Discovery — recognize direct agent-SDK call signatures

**Files:**
- Modify: `src/gigaphone/packs/python/pack.py` (`discover`, add helpers)
- Test: `tests/test_agent_call.py` (append)

**Interfaces:**
- Consumes: `agent_sdks.match_call_site`, `agent_sdks.AGENT_SDKS`.
- Produces: `PythonPack.discover` now emits `AGENT_CALL` descriptors. A function whose body contains a catalog-matched call becomes a descriptor with `match_call="<module>.<func>"`, `emit_name="<proj>.subagent.<framework>"`, `output_paths=<sdk.output_fields>`.

- [ ] **Step 1: Write the failing test (append)**

```python
from gigaphone.engine import discover as _discover  # add to imports at top if not present


def test_discovery_finds_direct_agent_sdk_call(tmp_path):
    (tmp_path / "harness.py").write_text(
        "from __future__ import annotations\n"
        "from agents import Runner\n\n"
        "def run_subagent(task):\n"
        "    return Runner.run(task)\n"
    )
    descs = _discover.discover(str(tmp_path))
    agent = next((d for d in descs if d.kind.value == "agent_call"), None)
    assert agent is not None
    assert agent.match_call == "harness.run_subagent"
    assert agent.emit_name == "harness.subagent.openai-agents"
    assert agent.output_paths == ["final_output"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_agent_call.py -k direct_agent_sdk -v`
Expected: FAIL — no `agent_call` descriptor (assert `agent is not None` fails).

- [ ] **Step 3: Add the discovery pass**

In `src/gigaphone/packs/python/pack.py`, add the import near the top:

```python
from gigaphone.packs.python import agent_sdks
```

In `PythonPack.discover`, after step 3 (the exec-sink fallback `for name, fn in funcs.by_name.items(): ...` block) and before `return _dedupe(out)`, add step 4:

```python
        # 4) agent-SDK dispatch (seed family B): a function whose body calls a known agent
        #    framework. The sub-agent is a black box by ownership — we wrap this function.
        for name, fn in funcs.by_name.items():
            if name.startswith("_"):
                continue
            sdk = _match_agent_sdk_fn(fn)
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

Add the module-level helper near the other `_…` helpers (e.g. after `_wraps_exec_sink`):

```python
def _match_agent_sdk_fn(fn: ast.FunctionDef):
    """Return the AgentSdk whose direct-call signature appears in this function body."""
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            sdk = agent_sdks.match_call_site(_attr_chain(n.func))
            if sdk is not None and sdk.calls:
                return sdk
    return None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_agent_call.py -k direct_agent_sdk -v`
Expected: PASS.

- [ ] **Step 5: Run the full suite (guard against false positives on existing fixtures)**

Run: `python3 -m pytest -q`
Expected: PASS — in particular `tests/test_e2e_onboarding.py` still finds exactly its gateway + 3 tools and no spurious `agent_call`.

- [ ] **Step 6: Commit**

```bash
git add src/gigaphone/packs/python/pack.py tests/test_agent_call.py
git commit -m "feat(discovery): recognize direct agent-SDK call signatures as agent_call boundaries"
```

---

### Task 4: Discovery — recognize the construct→carrier shape (the OpenHands case)

**Files:**
- Modify: `src/gigaphone/packs/python/pack.py` (extend `_match_agent_sdk_fn`)
- Test: `tests/test_agent_call.py` (append)

**Interfaces:**
- Produces: `_match_agent_sdk_fn` also matches a function that **both** constructs a catalog `constructs` symbol **and** calls a `carriers` method — the OpenHands "build an `Agent`, POST it to the agent-server" shape.

- [ ] **Step 1: Write the failing test (append)**

```python
def test_discovery_finds_construct_then_carrier_shape(tmp_path):
    # mimics OpenHands: build an Agent config, then httpx.post it to the agent-server
    (tmp_path / "service.py").write_text(
        "from __future__ import annotations\n"
        "from openhands.sdk import Agent\n"
        "import httpx\n\n"
        "def start_conversation(task, client):\n"
        "    agent = Agent(model='gpt-5')\n"
        "    resp = client.post('http://agent-server/api/conversations', json={'agent': agent})\n"
        "    return resp.json()\n"
    )
    descs = _discover.discover(str(tmp_path))
    agent = next((d for d in descs if d.kind.value == "agent_call"), None)
    assert agent is not None
    assert agent.match_call == "service.start_conversation"
    assert agent.emit_name == "service.subagent.openhands-sdk"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/test_agent_call.py -k construct_then_carrier -v`
Expected: FAIL — `_match_agent_sdk_fn` only checks direct calls so far.

- [ ] **Step 3: Extend `_match_agent_sdk_fn`**

Replace the helper from Task 3 with the construct-aware version:

```python
def _match_agent_sdk_fn(fn: ast.FunctionDef):
    """Return the AgentSdk this function dispatches to: either a direct call signature, or
    a construct (an Agent-config object) that flows into an outbound carrier (the OpenHands
    shape)."""
    constructed: set[str] = set()
    carrier_attrs: set[str] = set()
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            dotted = _attr_chain(n.func)
            direct = agent_sdks.match_call_site(dotted)
            if direct is not None and direct.calls:
                return direct
            tail = dotted.rsplit(".", 1)[-1]
            constructed.add(tail)
            carrier_attrs.add("." + tail)
    for sdk in agent_sdks.AGENT_SDKS:
        if sdk.constructs and sdk.carriers:
            if any(c in constructed for c in sdk.constructs) and any(
                c in carrier_attrs for c in sdk.carriers
            ):
                return sdk
    return None
```

Add the import for `AGENT_SDKS` access — already covered by `from gigaphone.packs.python import agent_sdks` (Task 3). Note `agent_sdks.AGENT_SDKS` is referenced via the module alias.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_agent_call.py -k "construct_then_carrier or direct_agent_sdk" -v`
Expected: PASS (both).

- [ ] **Step 5: Run the full suite**

Run: `python3 -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/gigaphone/packs/python/pack.py tests/test_agent_call.py
git commit -m "feat(discovery): recognize the construct->carrier agent-dispatch shape (OpenHands)"
```

---

### Task 5: End-to-end — agent-wrapper testclient, red → green → idempotent

**Files:**
- Create: `testclient/wrapper/__init__.py`, `testclient/wrapper/subagent_sdk.py`, `testclient/wrapper/harness.py`, `testclient/wrapper/tracing.py`, `testclient/wrapper/run_representative.py`
- Create: `tests/test_e2e_agent_wrapper.py`

**Interfaces:**
- Consumes: `engine.discover.discover`, `engine.detect.detect`, `engine.fix.apply_fixes`, `engine.verify.verify`, `OtelAdapter`, `config.save` (same surface as `tests/test_e2e_onboarding.py`).
- Produces: a fixture whose `run_subagent` boundary is `agent_call`/`untraced` before fix and traced+complete+nested after.

- [ ] **Step 1: Create the fixture — the sub-agent SDK black box**

```python
# testclient/wrapper/__init__.py
```
(empty file)

```python
# testclient/wrapper/subagent_sdk.py
"""Stand-in for a third-party agent SDK — the black box. GigaPhone instruments NOTHING here
(ownership boundary: the harness author does not own this sub-agent)."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Result:
    final_output: str
    events: list = field(default_factory=list)


class Runner:
    @staticmethod
    def run(task: str) -> "Result":
        # pretend to run a whole agent (remotely); return a complete result object
        return Result(final_output=f"done: {task}", events=["plan", "act", "observe"])
```

- [ ] **Step 2: Create the harness wrapper (the boundary) and tracing/representative path**

```python
# testclient/wrapper/harness.py
"""The harness wraps a whole sub-agent. `run_subagent` is the consumption boundary
(kind=agent_call). Before GigaPhone it has no span, so the complete sub-agent result never
reaches the trace — UNTRACED."""
from __future__ import annotations

from wrapper.subagent_sdk import Runner


def run_subagent(task: str):
    result = Runner.run(task)  # dispatch to the black-box sub-agent
    return result
```

```python
# testclient/wrapper/tracing.py
"""Customer observability wiring — honours $GIGAPHONE_SPAN_FILE, one JSON line per span
(identical read path to testclient/app/tracing.py)."""
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
    return trace.get_tracer("wrapper")
```

```python
# testclient/wrapper/run_representative.py
"""Representative path GigaPhone runs during `verify`: a root `agent` span that dispatches
the sub-agent once, so the adapter can confirm the agent_call span is nested + complete."""
from __future__ import annotations

from wrapper.harness import run_subagent
from wrapper.tracing import init_tracing, tracer


def main() -> str:
    init_tracing()
    with tracer().start_as_current_span("agent") as span:
        span.set_attribute("agent.task", "delegate to sub-agent")
        result = run_subagent("summarize the repo")
        span.set_attribute("agent.final", result.final_output)
        return result.final_output


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Write the e2e test (red → green → idempotent)**

```python
# tests/test_e2e_agent_wrapper.py
"""E2E: a harness that wraps a whole sub-agent. The agent_call boundary is UNTRACED before
GigaPhone and traced + complete + nested after (DESIGN §3, §10; spec 2026-06-26)."""
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

_TESTCLIENT = os.path.join(os.path.dirname(__file__), "..", "testclient", "wrapper")


@pytest.fixture
def repo(tmp_path):
    shutil.copytree(_TESTCLIENT, tmp_path / "wrapper")
    return str(tmp_path)


def test_agent_wrapper_red_then_green_then_idempotent(repo):
    backend = OtelAdapter()
    descs = _discover.discover(repo, "wrapper")
    # discovery recognized the sub-agent dispatch
    agent = next((d for d in descs if d.kind == BoundaryKind.AGENT_CALL), None)
    assert agent is not None and agent.match_call == "wrapper.harness.run_subagent"

    config.save(repo, descs)
    boundaries = _detect.detect(repo, descs, "wrapper")
    run_b = next(b for b in boundaries if b.func_name == "run_subagent")
    assert run_b.failure_modes == [FailureMode.UNTRACED]

    expectations = [backend.expectation_for(b) for b in boundaries if b.failure_modes]

    # RED: the sub-agent dispatch has no span yet
    before = _verify.verify(repo, expectations, backend)
    assert not all(v.ok for v in before)

    # FIX
    result = _fix.apply_fixes(repo, boundaries, backend)
    assert result.diffs

    # GREEN: the agent_call span is now present, nested under the agent root, complete
    after = _verify.verify(repo, expectations, backend)
    assert all(v.ok for v in after), [(v.tool, v.detail) for v in after]

    # the emitted span declares kind=agent
    harness_src = open(os.path.join(repo, "wrapper", "harness.py"), encoding="utf-8").read()
    assert 'kind="agent"' in harness_src

    # IDEMPOTENT
    boundaries2 = _detect.detect(repo, descs, "wrapper")
    rerun = _fix.apply_fixes(repo, boundaries2, backend)
    assert not rerun.diffs
```

- [ ] **Step 4: Run the e2e to verify red→green→idempotent**

Run: `python3 -m pytest tests/test_e2e_agent_wrapper.py -v`
Expected: PASS. (If `detect` cannot localize, recheck Task 1's `_analyze_fn` change.)

- [ ] **Step 5: Run the full suite**

Run: `python3 -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add testclient/wrapper tests/test_e2e_agent_wrapper.py
git commit -m "test(e2e): agent-wrapper testclient — agent_call red->green->idempotent"
```

---

### Task 6: Resolution — agent-aware question for an unresolved dispatch

**Files:**
- Modify: `src/gigaphone/engine/plan.py:49-58`
- Test: `tests/test_agent_call.py` (append)

**Interfaces:**
- Produces: when an `AGENT_CALL` descriptor fails to localize, the `Unresolved.question` names the sub-agent framing ("Which function dispatches the sub-agent and returns its result?"). `resolve.ingest_resolution` already accepts `kind="agent_call"` (verified by test).

- [ ] **Step 1: Write the failing test (append)**

```python
from gigaphone.core.model import Boundary  # ensure imported at top
from gigaphone.engine.plan import build_plan
from gigaphone.engine.resolve import ingest_resolution


def test_unresolved_agent_call_uses_agent_wording():
    desc = Descriptor(
        id="agent-x", kind=BoundaryKind.AGENT_CALL, match_call="svc.dispatch_unknown"
    )
    plan = build_plan([desc], boundaries=[])  # nothing localized
    assert len(plan.unresolved) == 1
    assert "sub-agent" in plan.unresolved[0].question


def test_resolution_ingests_agent_call_kind():
    resolution = {
        "resolutions": [
            {
                "id": "agent-x",
                "boundary_call": "svc.dispatch",
                "kind": "agent_call",
                "complete_output_fields": ["final_output"],
                "emit_name": "svc.subagent.custom",
            }
        ]
    }
    descriptors, unresolvable = ingest_resolution(resolution)
    assert descriptors[0].kind == BoundaryKind.AGENT_CALL
    assert unresolvable == []
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest tests/test_agent_call.py -k "agent_call_kind or agent_wording" -v`
Expected: FAIL on `test_unresolved_agent_call_uses_agent_wording` (current wording says "returns it to the agent loop", not "sub-agent"). `test_resolution_ingests_agent_call_kind` may already pass.

- [ ] **Step 3: Make the unresolved question kind-aware**

In `src/gigaphone/engine/plan.py`, replace the `unresolved` list comprehension:

```python
    unresolved = [
        Unresolved(d.id, d.match_call, _question_for(d))
        for d in descriptors
        if d.match_call not in resolved_calls and d.kind != BoundaryKind.LLM
    ]
    return Plan(records=records, unresolved=unresolved)


def _question_for(d: Descriptor) -> str:
    if d.kind == BoundaryKind.AGENT_CALL:
        return (
            f"Could not localize `{d.match_call}` (agent_call). Which function dispatches "
            "the sub-agent and returns its result? (The sub-agent itself is a black box — we "
            "trace only this boundary.)"
        )
    return (
        f"Could not localize `{d.match_call}` ({d.kind.value}). "
        "Which function consumes its result and returns it to the agent loop?"
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_agent_call.py -k "agent_call_kind or agent_wording" -v`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `python3 -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/gigaphone/engine/plan.py tests/test_agent_call.py
git commit -m "feat(resolve): agent-aware unresolved wording for sub-agent dispatches"
```

---

### Task 7: Documentation — ADR, DESIGN, SKILL.md (golden rule + flywheel)

**Files:**
- Create: `docs/adr/0008-agent-call-boundary.md`
- Modify: `docs/DESIGN.md` (the §8.4 boundary-kind list)
- Modify: `skills/gigaphone/SKILL.md` (golden-rule table + onboarding steps for catalog/suspect/contribution)

**Interfaces:** docs only — no code.

- [ ] **Step 1: Write ADR-0008**

```markdown
# 8. The agent_call boundary — a sub-agent is a black box by ownership

Date: 2026-06-26

## Status
Accepted

## Context
Harnesses that wrap a whole sub-agent (e.g. OpenHands → remote agent-server) hold no
in-process LLM call to anchor on, so bottom-up discovery finds nothing real.

## Decision
Add `BoundaryKind.AGENT_CALL`. Treat the sub-agent as a black box **by ownership** — the
repo owner is responsible only for their own dispatch boundary, not the sub-agent's
internals (the same rule that treats the sandbox as opaque, ADR-0003). Reuse the
untraced/lossy/off_context taxonomy and fix primitives; the only new surface is discovery,
via a data catalog of agent-SDK signatures (seed family B). Unknowns use the resolution
protocol (ADR-0006); confirmed signatures are contributed back as catalog entries.

## Consequences
- Context propagation *into* the sub-agent is out of scope (not the owner's responsibility,
  not verifiable as theirs). Cross-harness trees compose at the backend iff both export.
- `off_context` for an agent_call is scoped to the owner's own root trace.
- A new finite seed family (agent SDKs) sits beside LLM SDKs; tools remain derived, never
  seeded.
```

- [ ] **Step 2: Update DESIGN §8.4 kind list**

In `docs/DESIGN.md`, find the boundary-`kind` enumeration (the `llm` / `tool_exec` /
`tool_result_sink` list) and add:

```
- `agent_call` — a call that dispatches a whole sub-agent (black box by ownership);
  recognized via the Agent-SDK catalog (seed family B), wrapped like `tool_exec`.
```

- [ ] **Step 3: Add the agent_call row to the SKILL.md golden-rule table and onboarding steps**

In `skills/gigaphone/SKILL.md`, add a row to the failure-mode table:

```
| `agent_call`  | a call wraps a whole sub-agent (no in-process LLM); only the dispatch is yours | recognize via the agent-SDK catalog, then `trace_boundary(...)` (span kind=agent) |
```

And under "Guided onboarding", append to the discovery step:

```
   If the gateway scan finds no in-process LLM call but the repo dispatches to another agent
   framework (langgraph/crewai/openai-agents/openhands-sdk/…), discovery proposes an
   `agent_call` boundary from the Agent-SDK catalog. If you see a dispatch that looks like a
   sub-agent but matches no catalog entry, ask the user to confirm it (resolution protocol),
   then offer to contribute the new signature back to `packs/python/agent_sdks.py` as an OSS
   PR — you draft the entry with `agent_sdks.format_entry(...)`.
```

- [ ] **Step 4: Sanity-check docs render and commit**

Run: `python3 -m pytest -q` (docs change nothing, but confirm green before committing)
Expected: PASS.

```bash
git add docs/adr/0008-agent-call-boundary.md docs/DESIGN.md skills/gigaphone/SKILL.md
git commit -m "docs: ADR-0008 agent_call boundary + DESIGN/SKILL updates"
```

---

### Task 8: Honesty gate — independent tester runs GigaPhone against OpenHands

**Files:** none (verification task — produces a report, not code).

This task is executed by dispatching an **independent tester subagent that has NOT seen this
plan or the implementation** (keeps it honest — it behaves like a brand-new GigaPhone user).
Do not summarize the implementation to it.

- [ ] **Step 1: Dispatch the tester subagent with this exact brief**

> You are evaluating a trace-coverage tool called GigaPhone as a brand-new user. Do not read
> its source or tests. Install/run it only via its documented entrypoint.
>
> 1. Run the GigaPhone CLI from the branch checkout
>    (`/Users/jamesgao/Projects/gigaphone/.claude/worktrees/agent-call-boundary`) — invoke it
>    as `PYTHONPATH=<that>/src python3 -c "from gigaphone.cli import main; import sys; sys.exit(main(sys.argv[1:]))" discover --scope <path>`.
> 2. Point it at the OpenHands app/server repo at
>    `/Users/jamesgao/Projects/OpenHands/openhands/app_server/app_conversation` (and the
>    broader `openhands/app_server` if nothing is found).
> 3. Report: does `discover` propose an `agent_call` boundary for the dispatch to the remote
>    agent-server (the `httpx.post(.../api/conversations)` that carries an `openhands.sdk.Agent`
>    / `StartConversationRequest`)? Paste the produced `gigaphone.boundaries.yaml`.
> 4. Report any false positives (e.g. `get_docker_client`, `is_valid_git_branch_name`) and
>    whether the agent_call boundary is among the proposals.
> 5. Give a verdict: would a new user get a coherent, correct `agent_call` boundary here?

- [ ] **Step 2: Evaluate the tester's report against success criteria**

PASS if: the tester (without implementation knowledge) reports an `agent_call` boundary
proposed for the agent-server dispatch, and no fix is applied to the prior false positives.
If the construct→carrier match misses (e.g. the `Agent` build and the `.post` are in
different functions), capture that as a follow-up — the spec's success criterion #2 expects
the dispatch recognized where build + carrier share a function; a cross-function case routes
through resolution (Task 6), which is acceptable as long as it is surfaced, not silent.

- [ ] **Step 3: Record the verdict in the PR description**

Summarize the tester's findings (boundary found / false positives / verdict) in the PR body
when opening the PR for this branch.

---

## Self-Review

**Spec coverage:**
- "Add `BoundaryKind.AGENT_CALL`" → Task 1. ✓
- "reuse untraced/lossy/off_context + fix primitives" → Task 1 (analyze generalization, kind="agent"). ✓
- "Agent-SDK catalog as data (family B)" → Task 2. ✓
- "discovery pass — enclosing function of a catalog-matched call" → Tasks 3 (direct calls) & 4 (construct→carrier / OpenHands). ✓
- "resolution protocol for unknowns" → Task 6. ✓
- "OSS catalog contribution flywheel" → Task 2 (`format_entry`) + Task 7 (SKILL.md step). ✓
- "out of scope: context propagation into sub-agent" → ADR-0008 records the exclusion. ✓
- "verification strategy: independent honest tester vs OpenHands" → Task 8. ✓
- "zero regressions" → full-suite run in Tasks 1,3,4,5,6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `match_call_site`, `format_entry`, `AGENT_SDKS`, `_match_agent_sdk_fn`,
`AgentSdk` fields used identically across Tasks 2–4. `BoundaryKind.AGENT_CALL` value
`"agent_call"` used consistently in tests and code. `discover(repo[, scope])`,
`detect(repo, descs, scope)`, `verify(repo, expectations, backend)`,
`apply_fixes(repo, boundaries, backend)` match the signatures used in
`tests/test_e2e_onboarding.py`. ✓

## Execution Handoff

Plan complete. Two execution options — see handoff prompt after this document.
