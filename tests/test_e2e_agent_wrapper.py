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
