"""The backend adapters render TypeScript fix primitives (the pack<->backend wiring).

Before this, the OTel-family adapters only emitted Python (``from ... import gigaphone_*``),
so ``gigaphone fix`` on a TS repo produced a broken Python import + a no-op comment. These
tests pin the language-aware ``primitive_for(boundary, mode, lang)`` surface for all three
contextvars-family backends, and guard that the Python rendering is unchanged.
"""

from __future__ import annotations

import pytest

from gigaphone.adapters.backend.braintrust import BraintrustAdapter
from gigaphone.adapters.backend.langsmith import LangSmithAdapter
from gigaphone.adapters.backend.otel import OtelAdapter
from gigaphone.core.boundary import BoundaryKind, FailureMode
from gigaphone.core.model import Boundary, Range

_TS_SHIM = {
    OtelAdapter: "@gigaphone/otel",
    BraintrustAdapter: "@gigaphone/braintrust",
    LangSmithAdapter: "@gigaphone/langsmith",
}
_PY_SHIM = {
    OtelAdapter: "gigaphone.runtime.otel",
    BraintrustAdapter: "gigaphone.runtime.braintrust",
    LangSmithAdapter: "gigaphone.runtime.langsmith",
}


def _boundary(kind=BoundaryKind.TOOL_EXEC) -> Boundary:
    return Boundary(
        descriptor_id="tool-run",
        kind=kind,
        path="src/agent.ts",
        func_name="run",
        call="agent.run",
        range=Range("src/agent.ts", 0, 10, 1),
        complete_output_fields=["stdout", "exitCode"],
        tools_covered=["run"],
        emit_name="app.run",
    )


@pytest.mark.parametrize("adapter_cls", [OtelAdapter, BraintrustAdapter, LangSmithAdapter])
def test_typescript_untraced_renders_curried_call_and_ts_import(adapter_cls):
    p = adapter_cls().primitive_for(_boundary(), FailureMode.UNTRACED, "typescript")
    assert p.import_line == f'import {{ gigaphoneTrace }} from "{_TS_SHIM[adapter_cls]}";'
    # a real curried higher-order call (not a Python decorator, not a comment)
    assert (
        p.decorator
        == 'gigaphoneTrace({ name: "app.run", kind: "tool", output: ["stdout", "exitCode"] })'
    )
    assert p.backend_id == adapter_cls().id


@pytest.mark.parametrize("adapter_cls", [OtelAdapter, BraintrustAdapter, LangSmithAdapter])
def test_typescript_off_context_and_lossy_render_ts(adapter_cls):
    off = adapter_cls().primitive_for(_boundary(), FailureMode.OFF_CONTEXT, "typescript")
    assert off.import_line == f'import {{ gigaphonePropagate }} from "{_TS_SHIM[adapter_cls]}";'
    assert off.executor_wrapper == "gigaphonePropagate"

    lossy = adapter_cls().primitive_for(_boundary(), FailureMode.LOSSY_OUTPUT, "typescript")
    assert lossy.import_line == f'import {{ gigaphoneComplete }} from "{_TS_SHIM[adapter_cls]}";'
    assert lossy.attr_setter_template == "gigaphoneComplete({span}, {value}, {fields});"


def test_agent_call_renders_kind_agent_in_typescript():
    p = OtelAdapter().primitive_for(
        _boundary(BoundaryKind.AGENT_CALL), FailureMode.UNTRACED, "typescript"
    )
    assert 'kind: "agent"' in p.decorator


@pytest.mark.parametrize("adapter_cls", [OtelAdapter, BraintrustAdapter, LangSmithAdapter])
def test_python_rendering_is_unchanged(adapter_cls):
    # default lang stays python and byte-identical to the pre-multi-language adapter
    p = adapter_cls().primitive_for(_boundary(), FailureMode.UNTRACED)
    assert p.import_line == f"from {_PY_SHIM[adapter_cls]} import gigaphone_trace"
    assert (
        p.decorator
        == "gigaphone_trace(name=\"app.run\", kind=\"tool\", output=['stdout', 'exitCode'])"
    )
