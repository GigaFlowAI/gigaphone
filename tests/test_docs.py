"""Generated documentation artifacts: report.md + architecture.md (this feature, DESIGN §12).

Deterministic: built from the plan, the applied fixes, and the verified tree — no model
call. Written under docs/gigaphone/ in the customer's repo.
"""

from __future__ import annotations

import os
import shutil

import pytest

from gigaphone import config
from gigaphone.adapters.backend.otel import OtelAdapter
from gigaphone.engine import detect as _detect
from gigaphone.engine import discover as _discover
from gigaphone.engine import fix as _fix
from gigaphone.engine import report as _report
from gigaphone.engine import verify as _verify
from gigaphone.engine.plan import build_plan

_TESTCLIENT = os.path.join(os.path.dirname(__file__), "..", "testclient", "app")


@pytest.fixture
def flow(tmp_path):
    shutil.copytree(_TESTCLIENT, tmp_path / "app")
    repo = str(tmp_path)
    backend = OtelAdapter()
    descs = _discover.discover(repo, "app")
    config.save(repo, descs)
    boundaries = _detect.detect(repo, descs, "app")
    plan = build_plan(descs, boundaries)
    expectations = [backend.expectation_for(b) for b in boundaries if b.failure_modes]
    fix_result = _fix.apply_fixes(repo, boundaries, backend)
    tree = _verify.verify_tree(repo, expectations, backend)
    return repo, descs, plan, fix_result, tree


def test_report_md_outlines_problems_changes_and_verification(flow):
    repo, descs, plan, fix_result, tree = flow
    md = _report.render_report_md(
        harness="cli",
        language="python",
        backend="otel",
        plan=plan,
        fix_result=fix_result,
        tree=tree,
    )
    # the three required parts of the consolidated report
    assert "# GigaPhone" in md
    assert "## Problems found" in md
    assert "## Changes applied" in md
    assert "## Verification" in md
    # problems name the boundary, kind, and failure mode
    assert "run_code" in md and "lossy_output" in md
    # the llm gateway problem is outlined too
    assert "llm" in md.lower()
    # verification reports the coherent tree
    assert "single root" in md.lower()


def test_architecture_md_describes_the_integrated_telemetry(flow):
    repo, descs, plan, fix_result, tree = flow
    md = _report.render_architecture_md(
        harness="cli",
        language="python",
        backend="otel",
        descriptors=descs,
        plan=plan,
        tree=tree,
    )
    assert "# Telemetry Architecture" in md
    # the trace tree shape
    assert "agent" in md
    # every boundary's emit point is documented
    assert "run_code" in md and "web_search" in md and "fetch_url" in md
    # regression protection mentions the committed config
    assert "gigaphone.boundaries.yaml" in md


def test_write_docs_commits_both_files_under_docs_gigaphone(flow):
    repo, descs, plan, fix_result, tree = flow
    paths = _report.write_docs(
        repo,
        harness="cli",
        language="python",
        backend="otel",
        descriptors=descs,
        plan=plan,
        fix_result=fix_result,
        tree=tree,
    )
    report_path = os.path.join(repo, "docs", "gigaphone", "report.md")
    arch_path = os.path.join(repo, "docs", "gigaphone", "architecture.md")
    assert os.path.exists(report_path)
    assert os.path.exists(arch_path)
    assert set(paths) == {report_path, arch_path}
