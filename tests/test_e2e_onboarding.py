"""End-to-end onboarding e2e against the bundled testclient (DESIGN §14).

Proves the whole flow on a real agent app with a hand-rolled LLM gateway:
discovery → localization → (red) verify → fix → (green) verify → idempotent re-fix.

The pre-fix verify failing is the breaking fixture that proves each fix matters
(golden principle 5: no fix without a red fixture).
"""

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
from gigaphone.engine.plan import build_plan

_TESTCLIENT = os.path.join(os.path.dirname(__file__), "..", "testclient", "app")


@pytest.fixture
def repo(tmp_path):
    shutil.copytree(_TESTCLIENT, tmp_path / "app")
    return str(tmp_path)


def _expectations(backend, boundaries):
    return [backend.expectation_for(b) for b in boundaries if b.failure_modes]


def test_discovery_finds_the_hand_rolled_gateway_and_tools(repo):
    descs = _discover.discover(repo, "app")
    by_call = {d.match_call: d for d in descs}

    # the custom gateway is invisible to provider anchors — discovery must find it
    gw = by_call.get("app.gateway.LLMGateway.chat")
    assert gw is not None and gw.kind == BoundaryKind.LLM

    tools = {d.match_call for d in descs if d.kind == BoundaryKind.TOOL_EXEC}
    assert "app.exec_tool.run_code" in tools
    assert "app.web_tools.web_search" in tools
    assert "app.web_tools.fetch_url" in tools
    # init_tracing is not a tool — it must not be mistaken for an execution sink
    assert "app.tracing.init_tracing" not in tools


def test_localization_classifies_each_failure_mode(repo):
    descs = _discover.discover(repo, "app")
    boundaries = {b.func_name: b for b in _detect.detect(repo, descs, "app")}

    assert boundaries["run_code"].failure_modes == [FailureMode.UNTRACED]
    assert boundaries["run_code"].complete_output_fields == ["stdout", "stderr", "exit_code"]
    assert boundaries["fetch_url"].failure_modes == [FailureMode.OFF_CONTEXT]
    assert boundaries["web_search"].failure_modes == [FailureMode.LOSSY_OUTPUT]
    # the gateway is traced but misses the OpenInference convention -> lossy_output (llm)
    assert boundaries["chat"].kind == BoundaryKind.LLM
    assert boundaries["chat"].failure_modes == [FailureMode.LOSSY_OUTPUT]


def test_full_onboarding_flow_red_then_green_then_idempotent(repo):
    backend = OtelAdapter()
    descs = _discover.discover(repo, "app")
    config.save(repo, descs)
    boundaries = _detect.detect(repo, descs, "app")
    expectations = _expectations(backend, boundaries)
    assert len(expectations) == 4  # chat (llm) + run_code, web_search, fetch_url

    # --- RED: before any fix, the representative run loses/orphans/truncates spans ---
    before = _verify.verify(repo, expectations, backend)
    assert not all(v.ok for v in before), "pre-fix verify should fail (the breaking fixture)"
    assert {v.tool for v in before if not v.ok} == {"chat", "run_code", "web_search", "fetch_url"}

    # --- FIX: apply idempotent codemods, surfaced as diffs ---
    result = _fix.apply_fixes(repo, boundaries, backend)
    assert result.diffs, "fixes should produce diffs"

    # --- GREEN: every tool span is now nested + complete ---
    after = _verify.verify(repo, expectations, backend)
    assert all(v.ok for v in after), (
        f"post-fix verify failed: {[(v.tool, v.detail) for v in after]}"
    )

    # --- IDEMPOTENT: re-running fix changes nothing (no double-wrapping) ---
    boundaries2 = _detect.detect(repo, descs, "app")
    # the fixed boundaries no longer carry failure modes
    assert all(
        not b.failure_modes
        for b in boundaries2
        if b.func_name in {"chat", "run_code", "web_search", "fetch_url"}
    )
    rerun = _fix.apply_fixes(repo, boundaries2, backend)
    assert not rerun.diffs, "re-running fix must not change the file again"


def test_onboarding_report_counts(repo):
    backend = OtelAdapter()
    descs = _discover.discover(repo, "app")
    boundaries = _detect.detect(repo, descs, "app")
    plan = build_plan(descs, boundaries)
    from gigaphone.engine import report

    _fix.apply_fixes(repo, boundaries, backend)
    results = _verify.verify(repo, _expectations(backend, boundaries), backend)
    text = report.render(
        harness="cli", language="python", backend="otel", plan=plan, verify_results=results
    )
    assert "1 untraced" in text
    assert "1 off-context" in text
    assert "2 lossy" in text  # web_search (tool) + chat (llm gateway)
    assert "4/4" in text
