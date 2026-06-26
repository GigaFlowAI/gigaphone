"""End-to-end coherent trace-tree verification against the testclient.

A single representative run (LLM -> tool -> LLM) must produce ONE tree: a root agent span
with every LLM and tool span nested + complete, and each requested tool linked to its span.
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
from gigaphone.engine import verify as _verify

_TESTCLIENT = os.path.join(os.path.dirname(__file__), "..", "testclient", "app")


@pytest.fixture
def repo(tmp_path):
    shutil.copytree(_TESTCLIENT, tmp_path / "app")
    return str(tmp_path)


def _prepare(repo):
    backend = OtelAdapter()
    descs = _discover.discover(repo, "app")
    config.save(repo, descs)
    boundaries = _detect.detect(repo, descs, "app")
    expectations = [backend.expectation_for(b) for b in boundaries if b.failure_modes]
    return backend, boundaries, expectations


def test_tree_is_incoherent_before_fix(repo):
    backend, _boundaries, expectations = _prepare(repo)
    tree = _verify.verify_tree(repo, expectations, backend)
    assert not tree.ok, "pre-fix the tree must not verify (tool spans lost/orphaned/lossy)"


def test_tree_is_coherent_after_fix(repo):
    backend, boundaries, expectations = _prepare(repo)
    _fix.apply_fixes(repo, boundaries, backend)
    tree = _verify.verify_tree(repo, expectations, backend)

    assert tree.single_root
    assert tree.root_span_name == "agent"

    # the llm spans now carry the full OpenInference convention
    llm = [r for r in tree.results if r.kind_is_llm]
    assert llm and all(r.ok for r in llm), [(r.tool, r.detail) for r in llm if not r.ok]

    # every tool the model requested links to a nested + complete tool span
    assert {link.requested for link in tree.linkage} == {"run_code", "web_search", "fetch_url"}
    assert all(link.linked for link in tree.linkage)

    assert tree.ok
