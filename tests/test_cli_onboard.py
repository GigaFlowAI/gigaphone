"""CLI `onboard` wires the full feature: discover → fix → tree-verify → write docs.

It must verify LLM spans too (not just tools) and emit the committed markdown artifacts.
"""

from __future__ import annotations

import os
import shutil

import pytest

from gigaphone.cli import main

_TESTCLIENT = os.path.join(os.path.dirname(__file__), "..", "testclient", "app")


@pytest.fixture
def repo(tmp_path):
    shutil.copytree(_TESTCLIENT, tmp_path / "app")
    return str(tmp_path)


def test_onboard_writes_docs_and_verifies_the_tree(repo, capsys):
    rc = main(["onboard", "--repo", repo, "--scope", "app"])
    out = capsys.readouterr().out

    assert rc == 0, "onboard should succeed end-to-end (tree coherent)"
    assert os.path.exists(os.path.join(repo, "docs", "gigaphone", "report.md"))
    assert os.path.exists(os.path.join(repo, "docs", "gigaphone", "architecture.md"))
    # the run reports the generated artifacts
    assert "report.md" in out and "architecture.md" in out
    # llm coverage is part of the verified set (the gateway span name)
    assert "chat" in out or "llm" in out.lower()
