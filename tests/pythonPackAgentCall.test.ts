/**
 * agent_call boundary (Python pack): kind, localization, discovery, and the agent-SDK
 * catalog (DESIGN §8.4). Ported from tests/test_agent_call.py. Calls the pack directly and
 * builds FixPrimitive literals (no engine, no otel adapter).
 */

import { describe, expect, it } from "vitest";
import { BoundaryKind, FailureMode } from "../src/core/boundary.js";
import { Descriptor, type FixPrimitive } from "../src/core/model.js";
import * as agentSdks from "../src/packs/python/agentSdks.js";
import { PythonPack } from "../src/packs/python/index.js";

const WRAPPER_SRC = `from __future__ import annotations
from subagent_sdk import Runner

def run_subagent(task: str):
    result = Runner.run(task)
    return result
`;

function agentDescriptor(descs: Descriptor[]): Descriptor | undefined {
  return descs.find((d) => d.kind === "agent_call");
}

describe("agent_call kind + localization", () => {
  it("agent_call kind value is agent_call", () => {
    expect(BoundaryKind.AGENT_CALL).toBe("agent_call");
  });

  it("localizes an agent_call descriptor as untraced with the agent emit", () => {
    const pack = new PythonPack();
    const desc = new Descriptor({
      id: "agent-run_subagent",
      kind: BoundaryKind.AGENT_CALL,
      matchCall: "harness.run_subagent",
      emitName: "harness.subagent.openai-agents",
    });
    const boundaries = pack.analyze("harness.py", WRAPPER_SRC, [desc]);
    expect(boundaries).toHaveLength(1);
    const b = boundaries[0];
    expect(b.kind).toBe(BoundaryKind.AGENT_CALL);
    expect(b.failureModes).toEqual([FailureMode.UNTRACED]);
    expect(b.toolsCovered).toEqual(["run_subagent"]);

    // the UNTRACED fix for an agent_call is a native body-wrap declaring the span kind as
    // "agent" (not "tool"), under the emit name.
    const prim: FixPrimitive = {
      failureMode: FailureMode.UNTRACED,
      backendId: "otel",
      importLine: "from gigaphone.runtime.otel import gigaphone_trace",
      emitName: "harness.subagent.openai-agents",
    };
    const edit = pack.emitFix(b, prim, WRAPPER_SRC);
    expect(edit).not.toBeNull();
    const text = edit?.hunks.map((h) => h.newText).join("") ?? "";
    expect(text).toContain('"gigaphone.kind", "agent"');
    expect(text).toContain("harness.subagent.openai-agents");
  });
});

describe("agent-SDK catalog", () => {
  it("recognizes known call signatures", () => {
    expect(agentSdks.matchCallSite("graph.invoke")?.framework).toBe("langgraph");
    expect(agentSdks.matchCallSite("Runner.run")?.framework).toBe("openai-agents");
    expect(agentSdks.matchCallSite("os.path.join")).toBeNull();
  });

  it("matches method-only with package provenance", () => {
    expect(agentSdks.matchPackageMethod("agents", "run")?.framework).toBe("openai-agents");
    expect(agentSdks.matchPackageMethod("asyncio", "run")).toBeNull();
    expect(agentSdks.matchPackageMethod("langgraph", "invoke")?.framework).toBe("langgraph");
  });

  it("matches construct with package provenance", () => {
    expect(agentSdks.matchConstruct("StartConversationRequest", "openhands")?.framework).toBe(
      "openhands-sdk",
    );
    expect(agentSdks.matchConstruct("Agent", "openhands")?.framework).toBe("openhands-sdk");
    expect(agentSdks.matchConstruct("Agent", "langchain")).toBeNull();
  });

  it("exposes carrier methods", () => {
    expect(agentSdks.carrierMethods().has("post")).toBe(true);
  });

  it("formats a catalog entry round-tripping its shape", () => {
    const block = agentSdks.formatEntry("acme-agents", "acme-agents", {
      calls: ["AcmeRunner.run"],
      outputFields: ["final"],
    });
    expect(block).toContain("AcmeRunner.run");
    expect(block).toContain("acme-agents");
  });
});

describe("agent_call discovery", () => {
  const pack = new PythonPack();

  it("finds a direct agent-SDK call", () => {
    const descs = pack.discover(
      "harness.py",
      "from __future__ import annotations\n" +
        "from agents import Runner\n\n" +
        "def run_subagent(task):\n" +
        "    return Runner.run(task)\n",
    );
    const agent = agentDescriptor(descs);
    expect(agent).toBeDefined();
    expect(agent?.matchCall).toBe("harness.run_subagent");
    expect(agent?.emitName).toBe("harness.subagent.openai-agents");
    expect(agent?.outputPaths).toEqual(["final_output"]);
  });

  it("finds the construct-then-carrier shape (same function)", () => {
    const descs = pack.discover(
      "service.py",
      "from __future__ import annotations\n" +
        "from openhands.sdk import Agent\n" +
        "import httpx\n\n" +
        "def start_conversation(task, client):\n" +
        "    agent = Agent(model='gpt-5')\n" +
        "    resp = client.post('http://agent-server/api/conversations', json={'agent': agent})\n" +
        "    return resp.json()\n",
    );
    const agent = agentDescriptor(descs);
    expect(agent).toBeDefined();
    expect(agent?.matchCall).toBe("service.start_conversation");
    expect(agent?.emitName).toBe("service.subagent.openhands-sdk");
  });

  it("does not treat an incidental run() call as an agent boundary", () => {
    const descs = pack.discover(
      "u.py",
      "from __future__ import annotations\n" +
        "import asyncio\n\n" +
        "def call_async_from_sync(coro):\n" +
        "    return asyncio.run(coro)\n",
    );
    expect(descs.some((d) => d.kind === "agent_call")).toBe(false);
  });

  it("resolves a locally-constructed receiver", () => {
    const descs = pack.discover(
      "g.py",
      "from __future__ import annotations\n" +
        "from langgraph.graph import StateGraph\n\n" +
        "def run_graph(state):\n" +
        "    graph = StateGraph(state).compile()\n" +
        "    return graph.invoke(state)\n",
    );
    expect(descs.some((d) => d.kind === "agent_call" && d.matchCall === "g.run_graph")).toBe(true);
  });

  it("does not match an unresolvable param receiver", () => {
    const descs = pack.discover(
      "p.py",
      "from __future__ import annotations\n\n" +
        "def run_graph(graph, state):\n" +
        "    return graph.invoke(state)\n",
    );
    expect(descs.some((d) => d.kind === "agent_call")).toBe(false);
  });

  it("matches construct + carrier in different functions", () => {
    const descs = pack.discover(
      "svc.py",
      "from __future__ import annotations\n" +
        "from openhands.sdk import Agent\n" +
        "from openhands.models import StartConversationRequest\n" +
        "import httpx\n\n" +
        "def _build_request(task):\n" +
        "    return StartConversationRequest(agent=Agent(model='x'))\n\n" +
        "async def _start_app_conversation(task, client):\n" +
        "    req = _build_request(task)\n" +
        "    return await client.post('http://a/api/conversations', json=req)\n",
    );
    const agent = agentDescriptor(descs);
    expect(agent).toBeDefined();
    expect(agent?.matchCall).toBe("svc._start_app_conversation");
    expect(agent?.emitName).toBe("svc.subagent.openhands-sdk");
  });

  it("does not match an arbitrary Agent + post without framework provenance", () => {
    const descs = pack.discover(
      "x.py",
      "from __future__ import annotations\n" +
        "from mylib import Agent\n" +
        "import httpx\n\n" +
        "def handle(client):\n" +
        "    a = Agent()\n" +
        "    return client.post('http://a/x', json={'a': a})\n",
    );
    expect(descs.some((d) => d.kind === "agent_call")).toBe(false);
  });

  it("catches a factory-built dispatch via the return annotation", () => {
    const descs = pack.discover(
      "svc.py",
      "from __future__ import annotations\n" +
        "from openhands.agent_server.models import StartConversationRequest\n" +
        "import httpx\n\n" +
        "class S:\n" +
        "    async def _build_request(self, x) -> StartConversationRequest:\n" +
        "        settings = make_settings()\n" +
        "        agent = settings.create_agent()\n" +
        "        return _redact(StartConversationRequest, agent=agent)\n" +
        "    async def _start_app_conversation(self, x):\n" +
        "        req = await self._build_request(x)\n" +
        "        return await self.httpx_client.post('http://a/api/conversations', json=req)\n",
    );
    const agent = agentDescriptor(descs);
    expect(agent).toBeDefined();
    expect(agent?.matchCall).toBe("svc._start_app_conversation");
    expect(agent?.emitName).toBe("svc.subagent.openhands-sdk");
  });

  it("requires a carrier for the return-annotation signal", () => {
    const descs = pack.discover(
      "b.py",
      "from __future__ import annotations\n" +
        "from openhands.agent_server.models import StartConversationRequest\n\n" +
        "def _build(x) -> StartConversationRequest:\n" +
        "    return _redact(StartConversationRequest)\n\n" +
        "def caller(x):\n" +
        "    return _build(x)\n",
    );
    expect(descs.some((d) => d.kind === "agent_call")).toBe(false);
  });

  it("resolves a construct two hops deep from the carrier", () => {
    const descs = pack.discover(
      "svc.py",
      "from __future__ import annotations\n" +
        "from openhands.sdk import Agent\n" +
        "import httpx\n\n" +
        "def _build(task):\n" +
        "    return Agent(model='x')\n\n" +
        "def _assemble(task):\n" +
        "    return _build(task)\n\n" +
        "async def dispatch(task, client):\n" +
        "    req = _assemble(task)\n" +
        "    return await client.post('http://a/api/conversations', json={'a': req})\n",
    );
    const agent = agentDescriptor(descs);
    expect(agent).toBeDefined();
    expect(agent?.matchCall).toBe("svc.dispatch");
    expect(agent?.emitName).toBe("svc.subagent.openhands-sdk");
  });

  it("terminates on a recursive helper chain and does not match", () => {
    const descs = pack.discover(
      "r.py",
      "from __future__ import annotations\n" +
        "import httpx\n\n" +
        "def _a(x):\n" +
        "    return _b(x)\n\n" +
        "def _b(x):\n" +
        "    return _a(x)\n\n" +
        "def dispatch(x, client):\n" +
        "    y = _a(x)\n" +
        "    return client.post('http://a/x', json={'y': y})\n",
    );
    expect(descs.some((d) => d.kind === "agent_call")).toBe(false);
  });
});
