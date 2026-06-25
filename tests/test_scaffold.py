"""Scaffold smoke tests: the engine imports, the CLI runs, plan records round-trip.

Real detection/fix/verify tests land with their milestones (docs/IMPLEMENTATION_PLAN.md).
The golden principle "no fix without a red fixture" applies once fixes exist (M2+).
"""

from __future__ import annotations

from gigaphone import __version__
from gigaphone.cli import COMMANDS, main
from gigaphone.core import BoundaryKind, FailureMode, PlanRecord, Source


def test_version_is_set():
    assert __version__ == "0.4.0"


def test_cli_lists_the_six_subcommands():
    names = {name for name, _ in COMMANDS}
    assert names == {"discover", "detect", "plan", "resolve", "fix", "verify"}


def test_cli_version_flag_exits_zero(capsys):
    assert main(["--version"]) == 0
    assert "gigaphone" in capsys.readouterr().out


def test_cli_no_args_prints_help_exits_zero():
    assert main([]) == 0


def test_cli_stub_subcommand_signals_not_implemented():
    # Documented stub at scaffold stage — non-zero so CI never mistakes a stub for success.
    assert main(["plan"]) != 0


def test_plan_record_round_trips_through_json_shape():
    record = PlanRecord(
        boundary="tools/exec.py:42",
        language="python",
        provider_or_framework="acme-gateway",
        kind=BoundaryKind.TOOL_EXEC,
        tools_covered=["run_code", "run_bash"],
        failure_modes=[FailureMode.OFF_CONTEXT, FailureMode.LOSSY_OUTPUT],
        complete_output_fields=["stdout", "stderr", "exit_code"],
        source=Source.SPEC,
    )
    d = record.to_dict()
    # Matches the JSON shape documented in DESIGN §11.
    assert d["kind"] == "tool_exec"
    assert d["failure_modes"] == ["off_context", "lossy_output"]
    assert d["source"] == "spec"
    assert PlanRecord.from_dict(d) == record
