"""Resolution protocol, config round-trip, and drift detection (DESIGN §5, §8.4, §8.5)."""

from __future__ import annotations

from gigaphone import config
from gigaphone.core.boundary import BoundaryKind
from gigaphone.core.model import Descriptor
from gigaphone.engine.resolve import ingest_resolution
from gigaphone.engine.review import apply_review


def test_config_round_trips(tmp_path):
    descriptors = [
        Descriptor(
            id="acme-gateway",
            kind=BoundaryKind.LLM,
            match_call="our_llm.chat",
            input_arg="messages",
            output_paths=["response.text"],
            emit_name="acme.llm",
        ),
        Descriptor(
            id="acme-exec",
            kind=BoundaryKind.TOOL_EXEC,
            match_call="sandbox.execute",
            output_paths=["result.stdout", "result.stderr", "result.exit_code"],
            emit_name="acme.exec",
        ),
    ]
    config.save(str(tmp_path), descriptors)
    loaded = config.load(str(tmp_path))
    assert [d.match_call for d in loaded] == ["our_llm.chat", "sandbox.execute"]
    assert loaded[1].output_paths == ["result.stdout", "result.stderr", "result.exit_code"]


def test_resolution_protocol_ingests_and_flags_unresolvable():
    resolution = {
        "resolutions": [
            {
                "id": "exec-dispatch-7",
                "boundary_call": "runner._collect",
                "kind": "tool_exec",
                "complete_output_fields": ["stdout", "stderr", "exit_code"],
                "emit_name": "acme.exec",
            },
            {"id": "mystery-3", "unresolvable": True},
        ]
    }
    descriptors, unresolvable = ingest_resolution(resolution)
    assert len(descriptors) == 1
    assert descriptors[0].match_call == "runner._collect"
    assert descriptors[0].output_paths == ["stdout", "stderr", "exit_code"]
    assert unresolvable == ["mystery-3"]  # surfaced, never silently dropped (golden principle 8)


def test_drift_when_a_committed_anchor_no_longer_resolves():
    descriptors = [
        Descriptor(id="a", kind=BoundaryKind.TOOL_EXEC, match_call="app.tools.run_code"),
        Descriptor(id="b", kind=BoundaryKind.TOOL_EXEC, match_call="app.tools.gone"),
    ]
    resolved = {"app.tools.run_code"}  # only one still resolves
    drift = config.detect_drift(descriptors, resolved)
    assert drift == ["app.tools.gone"]


def test_review_rejects_false_positives_and_adds_missed():
    descriptors = [
        Descriptor(
            id="tool-get_docker_client",
            kind=BoundaryKind.TOOL_EXEC,
            match_call="app.sandbox.get_docker_client",
        ),
        Descriptor(
            id="tool-is_valid_git_branch_name",
            kind=BoundaryKind.TOOL_EXEC,
            match_call="app.utils.is_valid_git_branch_name",
        ),
    ]
    review = {
        "reject": ["tool-get_docker_client", "tool-is_valid_git_branch_name"],
        "add": [
            {
                "id": "agent-_start_app_conversation",
                "kind": "agent_call",
                "match_call": "app.conv.live_service._start_app_conversation",
                "output_paths": ["events", "final_message"],
                "emit_name": "openhands.subagent.openhands-sdk",
            }
        ],
    }
    updated, summary = apply_review(descriptors, review)
    calls = {d.match_call for d in updated}
    assert calls == {"app.conv.live_service._start_app_conversation"}  # both rejected, one added
    assert updated[0].kind == BoundaryKind.AGENT_CALL
    assert summary["rejected"] == ["tool-get_docker_client", "tool-is_valid_git_branch_name"]
    assert summary["added"] == ["app.conv.live_service._start_app_conversation"]
    assert summary["kept"] == 0


def test_review_keeps_unmentioned_and_dedupes_by_call():
    descriptors = [
        Descriptor(id="a", kind=BoundaryKind.TOOL_EXEC, match_call="app.x.run"),
        Descriptor(id="b", kind=BoundaryKind.LLM, match_call="app.gw.chat"),
    ]
    review = {
        "add": [{"id": "a2", "kind": "agent_call", "match_call": "app.x.run", "emit_name": "e"}]
    }
    updated, summary = apply_review(descriptors, review)
    by_call = {d.match_call: d for d in updated}
    assert set(by_call) == {"app.x.run", "app.gw.chat"}  # llm kept, run overridden by the add
    assert by_call["app.x.run"].kind == BoundaryKind.AGENT_CALL
    assert summary["kept"] == 2
