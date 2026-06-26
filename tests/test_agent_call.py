"""agent_call boundary: kind, localization, discovery, resolution, catalog (DESIGN §8.4)."""

from __future__ import annotations

from gigaphone.adapters.backend.otel import OtelAdapter
from gigaphone.core.boundary import BoundaryKind, FailureMode
from gigaphone.core.model import Descriptor
from gigaphone.engine import discover as _discover
from gigaphone.packs.python.pack import PythonPack

_WRAPPER_SRC = """\
from __future__ import annotations
from subagent_sdk import Runner

def run_subagent(task: str):
    result = Runner.run(task)
    return result
"""


def test_agent_call_kind_value():
    assert BoundaryKind.AGENT_CALL.value == "agent_call"


def test_agent_call_descriptor_localizes_as_untraced_with_agent_emit():
    pack = PythonPack()
    desc = Descriptor(
        id="agent-run_subagent",
        kind=BoundaryKind.AGENT_CALL,
        match_call="harness.run_subagent",
        emit_name="harness.subagent.openai-agents",
    )
    boundaries = pack.analyze("harness.py", _WRAPPER_SRC, [desc])
    assert len(boundaries) == 1
    b = boundaries[0]
    assert b.kind == BoundaryKind.AGENT_CALL
    assert b.failure_modes == [FailureMode.UNTRACED]
    assert b.tools_covered == ["run_subagent"]

    # the UNTRACED fix decorator must declare the span kind as "agent", not "tool"
    prim = OtelAdapter().primitive_for(b, FailureMode.UNTRACED)
    assert 'kind="agent"' in prim.decorator
    assert prim.emit_name == "harness.subagent.openai-agents"


def test_catalog_recognizes_known_call_signatures():
    from gigaphone.packs.python import agent_sdks

    # langgraph-style: a `.invoke` suffix; openai-agents: `Runner.run`
    assert agent_sdks.match_call_site("graph.invoke").framework == "langgraph"
    assert agent_sdks.match_call_site("Runner.run").framework == "openai-agents"
    # a plain method named invoke on an llm client must NOT be force-matched by exact name only
    assert agent_sdks.match_call_site("os.path.join") is None


def test_catalog_matches_method_only_with_package_provenance():
    from gigaphone.packs.python import agent_sdks

    assert agent_sdks.match_package_method("agents", "run").framework == "openai-agents"
    assert agent_sdks.match_package_method("asyncio", "run") is None
    assert agent_sdks.match_package_method("langgraph", "invoke").framework == "langgraph"


def test_catalog_matches_construct_with_package_provenance():
    from gigaphone.packs.python import agent_sdks

    assert (
        agent_sdks.match_construct("StartConversationRequest", "openhands").framework
        == "openhands-sdk"
    )
    assert agent_sdks.match_construct("Agent", "openhands").framework == "openhands-sdk"
    assert agent_sdks.match_construct("Agent", "langchain") is None


def test_carrier_methods_exposed():
    from gigaphone.packs.python import agent_sdks

    assert "post" in agent_sdks.carrier_methods()


def test_catalog_entry_formatter_round_trips_shape():
    from gigaphone.packs.python import agent_sdks

    block = agent_sdks.format_entry(
        "acme-agents", "acme-agents", calls=("AcmeRunner.run",), output_fields=("final",)
    )
    assert "AcmeRunner.run" in block
    assert "acme-agents" in block


def test_discovery_finds_direct_agent_sdk_call(tmp_path):
    (tmp_path / "harness.py").write_text(
        "from __future__ import annotations\n"
        "from agents import Runner\n\n"
        "def run_subagent(task):\n"
        "    return Runner.run(task)\n"
    )
    descs = _discover.discover(str(tmp_path))
    agent = next((d for d in descs if d.kind.value == "agent_call"), None)
    assert agent is not None
    assert agent.match_call == "harness.run_subagent"
    assert agent.emit_name == "harness.subagent.openai-agents"
    assert agent.output_paths == ["final_output"]


def test_discovery_finds_construct_then_carrier_shape(tmp_path):
    # mimics OpenHands: build an Agent config, then httpx.post it to the agent-server
    (tmp_path / "service.py").write_text(
        "from __future__ import annotations\n"
        "from openhands.sdk import Agent\n"
        "import httpx\n\n"
        "def start_conversation(task, client):\n"
        "    agent = Agent(model='gpt-5')\n"
        "    resp = client.post('http://agent-server/api/conversations', json={'agent': agent})\n"
        "    return resp.json()\n"
    )
    descs = _discover.discover(str(tmp_path))
    agent = next((d for d in descs if d.kind.value == "agent_call"), None)
    assert agent is not None
    assert agent.match_call == "service.start_conversation"
    assert agent.emit_name == "service.subagent.openhands-sdk"


def test_unresolved_agent_call_uses_agent_wording():
    from gigaphone.engine.plan import build_plan

    desc = Descriptor(id="agent-x", kind=BoundaryKind.AGENT_CALL, match_call="svc.dispatch_unknown")
    plan = build_plan([desc], boundaries=[])  # nothing localized
    assert len(plan.unresolved) == 1
    assert "sub-agent" in plan.unresolved[0].question


def test_resolution_ingests_agent_call_kind():
    from gigaphone.engine.resolve import ingest_resolution

    resolution = {
        "resolutions": [
            {
                "id": "agent-x",
                "boundary_call": "svc.dispatch",
                "kind": "agent_call",
                "complete_output_fields": ["final_output"],
                "emit_name": "svc.subagent.custom",
            }
        ]
    }
    descriptors, unresolvable = ingest_resolution(resolution)
    assert descriptors[0].kind == BoundaryKind.AGENT_CALL
    assert unresolvable == []


def _discover_src(tmp_path, name, src):
    (tmp_path / name).write_text(src)
    return _discover.discover(str(tmp_path))


def test_direct_call_matches_only_with_provenance(tmp_path):
    descs = _discover_src(
        tmp_path,
        "h.py",
        "from __future__ import annotations\n"
        "from agents import Runner\n\n"
        "def run_subagent(task):\n"
        "    return Runner.run(task)\n",
    )
    agent = next((d for d in descs if d.kind.value == "agent_call"), None)
    assert agent is not None and agent.match_call == "h.run_subagent"
    assert agent.emit_name == "h.subagent.openai-agents"


def test_incidental_run_call_is_not_an_agent_boundary(tmp_path):
    descs = _discover_src(
        tmp_path,
        "u.py",
        "from __future__ import annotations\n"
        "import asyncio\n\n"
        "def call_async_from_sync(coro):\n"
        "    return asyncio.run(coro)\n",
    )
    assert not any(d.kind.value == "agent_call" for d in descs)


def test_locally_constructed_receiver_resolves(tmp_path):
    descs = _discover_src(
        tmp_path,
        "g.py",
        "from __future__ import annotations\n"
        "from langgraph.graph import StateGraph\n\n"
        "def run_graph(state):\n"
        "    graph = StateGraph(state).compile()\n"
        "    return graph.invoke(state)\n",
    )
    assert any(d.kind.value == "agent_call" and d.match_call == "g.run_graph" for d in descs)


def test_unresolvable_param_receiver_does_not_match(tmp_path):
    descs = _discover_src(
        tmp_path,
        "p.py",
        "from __future__ import annotations\n\n"
        "def run_graph(graph, state):\n"
        "    return graph.invoke(state)\n",
    )
    assert not any(d.kind.value == "agent_call" for d in descs)


def test_construct_carrier_same_function(tmp_path):
    descs = _discover_src(
        tmp_path,
        "s.py",
        "from __future__ import annotations\n"
        "from openhands.sdk import Agent\n"
        "import httpx\n\n"
        "def start(task, client):\n"
        "    agent = Agent(model='x')\n"
        "    return client.post('http://a/api/conversations', json={'a': agent})\n",
    )
    assert any(d.kind.value == "agent_call" and d.match_call == "s.start" for d in descs)


def test_construct_in_helper_carrier_in_poster_DIFFERENT_functions(tmp_path):
    descs = _discover_src(
        tmp_path,
        "svc.py",
        "from __future__ import annotations\n"
        "from openhands.sdk import Agent\n"
        "from openhands.models import StartConversationRequest\n"
        "import httpx\n\n"
        "def _build_request(task):\n"
        "    return StartConversationRequest(agent=Agent(model='x'))\n\n"
        "async def _start_app_conversation(task, client):\n"
        "    req = _build_request(task)\n"
        "    return await client.post('http://a/api/conversations', json=req)\n",
    )
    agent = next((d for d in descs if d.kind.value == "agent_call"), None)
    assert agent is not None and agent.match_call == "svc._start_app_conversation"
    assert agent.emit_name == "svc.subagent.openhands-sdk"


def test_arbitrary_agent_plus_post_without_framework_provenance_does_not_match(tmp_path):
    descs = _discover_src(
        tmp_path,
        "x.py",
        "from __future__ import annotations\n"
        "from mylib import Agent\n"
        "import httpx\n\n"
        "def handle(client):\n"
        "    a = Agent()\n"
        "    return client.post('http://a/x', json={'a': a})\n",
    )
    assert not any(d.kind.value == "agent_call" for d in descs)


def test_return_annotation_signal_catches_factory_built_dispatch(tmp_path):
    descs = _discover_src(
        tmp_path,
        "svc.py",
        "from __future__ import annotations\n"
        "from openhands.agent_server.models import StartConversationRequest\n"
        "import httpx\n\n"
        "class S:\n"
        "    async def _build_request(self, x) -> StartConversationRequest:\n"
        "        settings = make_settings()\n"
        "        agent = settings.create_agent()\n"
        "        return _redact(StartConversationRequest, agent=agent)\n"
        "    async def _start_app_conversation(self, x):\n"
        "        req = await self._build_request(x)\n"
        "        return await self.httpx_client.post('http://a/api/conversations', json=req)\n",
    )
    agent = next((d for d in descs if d.kind.value == "agent_call"), None)
    assert agent is not None and agent.match_call == "svc._start_app_conversation"
    assert agent.emit_name == "svc.subagent.openhands-sdk"


def test_return_annotation_requires_carrier(tmp_path):
    # a builder annotated -> StartConversationRequest but with NO outbound carrier is not a dispatch
    descs = _discover_src(
        tmp_path,
        "b.py",
        "from __future__ import annotations\n"
        "from openhands.agent_server.models import StartConversationRequest\n\n"
        "def _build(x) -> StartConversationRequest:\n"
        "    return _redact(StartConversationRequest)\n\n"
        "def caller(x):\n"
        "    return _build(x)\n",  # no .post anywhere
    )
    assert not any(d.kind.value == "agent_call" for d in descs)
