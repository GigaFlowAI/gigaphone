"""OTel-native backend adapters (Logfire + Arize/Phoenix) — the OTel family.

Logfire and Phoenix/Arize are OTel-native (DESIGN §9): they set up a global OTel
TracerProvider, so gigaphone's OTel-API spans land in the backend unchanged. The adapters
therefore inherit the whole fix-routing / expectation / verify surface from ``OtelAdapter``
and override only the vendor-divergent surface (id, shim, detection, config, init). The
Logfire shim prefers ``logfire.span()`` when the SDK is present and degrades to the OTel
primitives otherwise; the Phoenix shim is the OTel shim (OpenInference spans go through the
OTel API). Both import cleanly without the vendor SDKs installed.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest

from gigaphone.adapters.backend.logfire import LogfireAdapter
from gigaphone.adapters.backend.phoenix import PhoenixAdapter
from gigaphone.adapters.registry import backend_by_id, select_backend
from gigaphone.core.boundary import BoundaryKind, FailureMode
from gigaphone.core.model import Boundary, Range
from gigaphone.runtime import logfire as logfire_shim
from gigaphone.runtime import phoenix as phoenix_shim


def _boundary() -> Boundary:
    return Boundary(
        descriptor_id="tool-run",
        kind=BoundaryKind.TOOL_EXEC,
        path="app/x.py",
        func_name="run",
        call="app.x.run",
        range=Range("app/x.py", 0, 10, 1),
        complete_output_fields=["stdout", "stderr", "exit_code"],
        tools_covered=["run"],
        emit_name="app.run",
        existing_span_name="run",
    )


@pytest.mark.parametrize(
    ("adapter_cls", "shim_module"),
    [
        (LogfireAdapter, "gigaphone.runtime.logfire"),
        (PhoenixAdapter, "gigaphone.runtime.phoenix"),
    ],
)
def test_primitive_for_all_modes_points_at_native_shim(adapter_cls, shim_module):
    adapter = adapter_cls()
    b = _boundary()

    untraced = adapter.primitive_for(b, FailureMode.UNTRACED)
    assert untraced.backend_id == adapter.id
    assert untraced.import_line == f"from {shim_module} import gigaphone_trace"
    assert untraced.decorator and "gigaphone_trace(" in untraced.decorator

    off_ctx = adapter.primitive_for(b, FailureMode.OFF_CONTEXT)
    assert off_ctx.import_line == f"from {shim_module} import gigaphone_propagate"
    assert off_ctx.executor_wrapper == "gigaphone_propagate"

    lossy = adapter.primitive_for(b, FailureMode.LOSSY_OUTPUT)
    assert lossy.import_line == f"from {shim_module} import gigaphone_complete"
    assert lossy.attr_setter_template and "gigaphone_complete(" in lossy.attr_setter_template


@pytest.mark.parametrize("adapter_cls", [LogfireAdapter, PhoenixAdapter])
def test_expectations_reuse_the_family_keys(adapter_cls):
    b = _boundary()
    b.failure_modes = [FailureMode.UNTRACED]
    b.requires_complete_attrs = True
    b.existing_span_name = None  # an untraced boundary has no existing span; it gets emit_name
    exp = adapter_cls().expectation_for(b)
    assert exp.span_name == "app.run"
    assert exp.require_attrs == [
        "gigaphone.output.stdout",
        "gigaphone.output.stderr",
        "gigaphone.output.exit_code",
    ]


def test_detect_presence_scans_for_the_sdk_import(tmp_path):
    (tmp_path / "uses_logfire.py").write_text("import logfire\nlogfire.configure()\n")
    (tmp_path / "uses_phoenix.py").write_text("from phoenix.otel import register\n")
    (tmp_path / "uses_arize.py").write_text("from arize.otel import register\n")
    assert LogfireAdapter().detect_presence(str(tmp_path)) is True
    assert PhoenixAdapter().detect_presence(str(tmp_path)) is True

    other = tmp_path / "sub"
    other.mkdir()
    (other / "plain.py").write_text("import os\n")
    assert LogfireAdapter().detect_presence(str(other)) is False
    assert PhoenixAdapter().detect_presence(str(other)) is False


def test_phoenix_detects_arize_alone(tmp_path):
    (tmp_path / "app.py").write_text("from arize.otel import register\nregister()\n")
    assert PhoenixAdapter().detect_presence(str(tmp_path)) is True
    assert LogfireAdapter().detect_presence(str(tmp_path)) is False


def test_init_snippets_are_vendor_native():
    logfire_init = LogfireAdapter().init_snippet({"service_name": "svc"})
    assert "import logfire" in logfire_init
    assert "logfire.configure(" in logfire_init

    phoenix_init = PhoenixAdapter().init_snippet({"project": "proj"})
    assert "register(" in phoenix_init


def test_config_schema_exposes_vendor_keys():
    assert "token" in LogfireAdapter().config_schema()
    phoenix_schema = PhoenixAdapter().config_schema()
    assert "endpoint" in phoenix_schema and "project" in phoenix_schema


@pytest.mark.parametrize(
    ("backend_id", "adapter_cls"),
    [("logfire", LogfireAdapter), ("phoenix", PhoenixAdapter)],
)
def test_registry_exposes_and_selects_the_native_adapter(backend_id, adapter_cls, tmp_path):
    assert isinstance(backend_by_id(backend_id), adapter_cls)
    assert isinstance(select_backend(str(tmp_path), preferred=backend_id), adapter_cls)


def test_select_backend_detects_logfire_repo(tmp_path):
    (tmp_path / "app.py").write_text("import logfire\nlogfire.configure()\n")
    assert isinstance(select_backend(str(tmp_path)), LogfireAdapter)


def test_select_backend_detects_phoenix_repo(tmp_path):
    (tmp_path / "app.py").write_text("from phoenix.otel import register\nregister()\n")
    assert isinstance(select_backend(str(tmp_path)), PhoenixAdapter)


@pytest.mark.parametrize("shim", [logfire_shim, phoenix_shim])
def test_shim_imports_lazily_and_falls_back_without_sdk(shim, monkeypatch):
    # Contract: with the vendor SDK absent the lazy probe returns None and the shim degrades
    # to the OTel primitives. Force the probe to None so this holds regardless of whether the
    # SDK happens to be installed in the dev env (phoenix has no probe — it re-exports OTel).
    if hasattr(shim, "_logfire"):
        monkeypatch.setattr(shim, "_logfire", lambda: None)

    @shim.gigaphone_trace(name="t", output=["value"])
    def f(x):
        return {"value": x, "extra": "dropped"}

    assert f(7) == {"value": 7, "extra": "dropped"}  # decorator is transparent to the result

    with ThreadPoolExecutor(max_workers=2) as ex:
        wrapped = shim.gigaphone_propagate(ex)
        assert wrapped.submit(lambda: 21).result() == 21
        # idempotent: wrapping twice does not double-wrap
        assert shim.gigaphone_propagate(wrapped) is wrapped

    captured = {}

    class _FakeOtelSpan:
        def set_attribute(self, k, v):
            captured[k] = v

    shim.gigaphone_complete(_FakeOtelSpan(), {"value": 1}, fields=["value"])
    assert captured.get("gigaphone.output.value") == "1"


def test_logfire_native_span_path_is_transparent():
    # When the logfire SDK is present, gigaphone_trace uses logfire.span(); the decorator
    # must stay transparent to the wrapped function's return value. Configure offline so no
    # data is sent and no NotConfigured warning fires.
    logfire = pytest.importorskip("logfire")
    logfire.configure(send_to_logfire=False, console=False)
    assert logfire_shim._logfire() is not None  # the native branch is the one under test

    @logfire_shim.gigaphone_trace(name="native-tool", output=["value"])
    def f(x):
        return {"value": x, "extra": "dropped"}

    assert f(7) == {"value": 7, "extra": "dropped"}


@pytest.mark.parametrize("shim", [logfire_shim, phoenix_shim])
def test_shim_exposes_llm_primitives(shim):
    # OTel-native backends carry the OpenInference llm.* convention through the OTel API, so
    # the LLM fixes (gigaphone_llm_trace / gigaphone_llm_complete) must resolve on the shim.
    assert callable(shim.gigaphone_llm_trace)
    assert callable(shim.gigaphone_llm_complete)
