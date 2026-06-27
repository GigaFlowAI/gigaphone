"""End-to-end TypeScript onboarding: red -> green -> idempotent against a live Node run.

Mirrors ``test_e2e_onboarding.py`` (Python) for the TypeScript language pack. Proves the
whole wire path: discover the tool boundaries, classify them untraced, apply the codemod
(real ``gigaphoneTrace`` body-wrap + import), then run the representative path under Node and
read back the exported spans — confirming each tool span is now nested under the agent root
and complete, and that re-detecting finds nothing left to fix.

Requires ``node`` (>= 23.6 for ``.ts`` type-stripping); skipped otherwise.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from gigaphone import config
from gigaphone.adapters.registry import select_backend
from gigaphone.engine import detect as _detect
from gigaphone.engine import discover as _discover
from gigaphone.engine import fix as _fix

REPO = Path(__file__).resolve().parents[1]
TESTCLIENT = REPO / "testclient-ts"
SHIM = REPO / "runtime" / "typescript" / "gigaphone-core.mjs"

_node = shutil.which("node")


def _node_supports_ts() -> bool:
    if _node is None:
        return False
    # type-stripping applies to .ts *files*, so probe with a real temp file.
    try:
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "probe.ts"
            f.write_text("const x: number = 1;\nconsole.log(x);\n")
            p = subprocess.run([_node, str(f)], capture_output=True, text=True, timeout=20)
            return p.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


pytestmark = pytest.mark.skipif(
    not _node_supports_ts(), reason="node with .ts type-stripping (>=23.6) required"
)


def _setup_project(tmp_path: Path) -> Path:
    dst = tmp_path / "proj"
    shutil.copytree(TESTCLIENT, dst)
    # vendor the runtime shim as @gigaphone/otel so the fixed code's import resolves
    pkg = dst / "node_modules" / "@gigaphone" / "otel"
    pkg.mkdir(parents=True)
    shutil.copy(SHIM, pkg / "index.mjs")
    (pkg / "package.json").write_text(
        json.dumps(
            {"name": "@gigaphone/otel", "version": "0.0.0", "type": "module", "main": "index.mjs"}
        )
    )
    return dst


def _project_ctx(root: Path) -> dict:
    return {
        "repo": str(root),
        "root": str(root),
        "lang": "typescript",
        "entry": "app/run_representative.ts",
    }


def test_typescript_onboarding_red_then_green_then_idempotent(tmp_path):
    root = _setup_project(tmp_path)
    backend = select_backend(str(root), "otel")

    descriptors = _discover.discover(str(root), None)
    config.save(str(root), descriptors)
    boundaries = _detect.detect(str(root), descriptors, None)

    tools = {b.func_name for b in boundaries if b.kind.value == "tool_exec"}
    assert {"runCode", "webSearch"} <= tools, f"discovery missed tools: {tools}"

    expectations = [backend.expectation_for(b) for b in boundaries if b.kind.value == "tool_exec"]
    ctx = _project_ctx(root)

    # RED: before the fix the tools are untraced -> their spans never reach the trace.
    red = backend.verify(ctx, expectations)
    assert red and any(not r.ok for r in red), f"expected missing tool spans, got {red}"

    # GREEN: apply the codemod, then the tool spans land nested + complete under the agent.
    result = _fix.apply_fixes(str(root), boundaries, backend)
    assert result.diffs, "fix produced no edits"
    green = backend.verify(ctx, expectations)
    assert all(r.ok for r in green), [(r.tool, r.detail) for r in green]

    # IDEMPOTENT: re-detecting the saved config finds nothing left to fix, and re-applying
    # changes nothing.
    boundaries2 = _detect.detect(str(root), config.load(str(root)), None)
    assert all(not b.failure_modes for b in boundaries2), "boundaries still unfixed after fix"
    again = _fix.apply_fixes(str(root), boundaries2, backend)
    assert not again.diffs, "re-applying the fix changed the source (not idempotent)"


def test_typescript_fix_emits_valid_runnable_code(tmp_path):
    """The fixed tool file must import the shim once (outside any import block) and wrap the
    body in a real curried gigaphoneTrace call — and the whole app must still run on Node."""
    root = _setup_project(tmp_path)
    backend = select_backend(str(root), "otel")
    descriptors = _discover.discover(str(root), None)
    boundaries = _detect.detect(str(root), descriptors, None)
    _fix.apply_fixes(str(root), boundaries, backend)

    tools_src = (root / "app" / "tools.ts").read_text()
    assert 'import { gigaphoneTrace } from "@gigaphone/otel";' in tools_src
    assert "gigaphoneTrace({" in tools_src and "})(" in tools_src
    assert tools_src.count("{") == tools_src.count("}")

    # the app still runs (no syntax error) under Node
    proc = subprocess.run(
        [_node, "app/run_representative.ts"],
        cwd=str(root),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
