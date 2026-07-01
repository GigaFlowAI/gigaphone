/**
 * CodebaseAdapter axis (ADR-0010): the scaffold stub, the bundled OpenHands example, the
 * discovery union (authored knowledge takes precedence over generic heuristics), repo-local
 * proprietary loading, and detect-based selection.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HermesAdapter,
  OpenHandsAdapter,
  SCAFFOLD_FILENAME,
  detectAdapters,
  loadRepoAdapter,
  scaffoldSource,
} from "../src/adapters/codebase/index.js";
import { BoundaryKind } from "../src/core/boundary.js";
import { Descriptor } from "../src/core/model.js";
import { discover } from "../src/engine/discover.js";
import { CodebaseAdapter } from "../src/interfaces/codebaseAdapter.js";

function tmpRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gigaphone_cb_"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(root, rel), content);
  return root;
}

describe("CodebaseAdapter scaffold", () => {
  it("generates a fillable stub: extends CodebaseAdapter, required detect, default export", () => {
    const src = scaffoldSource("arcanist");
    expect(SCAFFOLD_FILENAME).toBe("gigaphone.codebase.ts");
    expect(src).toContain("export default class ArcanistAdapter extends CodebaseAdapter");
    expect(src).toContain('readonly id = "arcanist"');
    expect(src).toContain("detect(repo: string): boolean");
    expect(src).toContain('from "gigaphone/interfaces"');
    expect(src).toContain("override discover(");
    expect(src).toContain("override redactionModel(");
  });
});

describe("bundled OpenHands example", () => {
  it("detects a repo that references openhands", () => {
    const yes = tmpRepo({ "svc.py": "from openhands.sdk import Agent\n" });
    const no = tmpRepo({ "svc.py": "import os\n" });
    expect(new OpenHandsAdapter().detect(yes)).toBe(true);
    expect(new OpenHandsAdapter().detect(no)).toBe(false);
  });

  it("recognizes the conversations-POST dispatch as an agent_call", () => {
    const source =
      "from openhands.sdk import Agent\n" +
      "import httpx\n\n" +
      "def start_conversation(task, client):\n" +
      "    req = _build(task)\n" +
      "    return client.post('http://a/api/conversations', json=req)\n";
    const descs = new OpenHandsAdapter().discover("service.py", source);
    expect(descs.length).toBe(1);
    expect(descs[0]!.kind).toBe(BoundaryKind.AGENT_CALL);
    expect(descs[0]!.matchCall).toBe("service.start_conversation");
    expect(descs[0]!.emitName).toBe("service.subagent.openhands");
    expect(descs[0]!.outputPaths).toEqual(["events", "final_message"]);
  });
});

describe("bundled Hermes example (authoritative hook-bus adapter)", () => {
  const TOOL = [
    "def _emit_post_tool_call_hook(*, function_name, result):",
    "    from hermes_cli.plugins import has_hook, invoke_hook",
    "    if has_hook('post_tool_call'):",
    "        invoke_hook('post_tool_call', tool_name=function_name, result=result)",
    "",
    "def handle_function_call(function_name, function_args):",
    "    result = registry.dispatch(function_name, function_args)",
    "    _emit_post_tool_call_hook(function_name=function_name, result=result)",
    "    return result",
    "",
  ].join("\n");
  const GATEWAY = [
    // sync gateway: forwards the request parameter directly
    "def interruptible_api_call(agent, api_kwargs):",
    "    return request_client.chat.completions.create(**api_kwargs)",
    "",
    // streaming gateway: forwards the request parameter via a {**param} spread
    "def interruptible_streaming_api_call(agent, api_kwargs):",
    "    stream_kwargs = {**api_kwargs, 'stream': True}",
    "    return request_client.chat.completions.create(**stream_kwargs)",
    "",
    // side path: assembles a fresh request from scratch — NOT param-forwarded",
    "def handle_max_iterations(agent, messages, api_call_count):",
    "    summary_kwargs = {'model': agent.model, 'messages': messages}",
    "    return client.chat.completions.create(**summary_kwargs)",
    "",
    "def run_inline_shell(cmd):",
    "    import subprocess",
    "    return subprocess.run(cmd, shell=True)",
    "",
  ].join("\n");

  it("detects hermes by the post_tool_call hook emitter, not arbitrary repos", () => {
    expect(new HermesAdapter().detect(tmpRepo({ "model_tools.py": TOOL }))).toBe(true);
    expect(new HermesAdapter().detect(tmpRepo({ "x.py": "import os\n" }))).toBe(false);
  });

  it("recognizes the tool-dispatch seam (handle_function_call), not the hook emitter itself", () => {
    const descs = new HermesAdapter().discover("model_tools.py", TOOL);
    expect(descs.length).toBe(1);
    expect(descs[0]!.kind).toBe(BoundaryKind.TOOL_EXEC);
    expect(descs[0]!.matchCall).toBe("model_tools.handle_function_call");
    expect(descs[0]!.emitName).toBe("hermes.tool");
  });

  it("recognizes request-forwarding gateways (direct + spread), excluding the from-scratch side-path", () => {
    const descs = new HermesAdapter().discover("chat_completion_helpers.py", GATEWAY);
    const calls = descs.map((d) => d.matchCall);
    // both gateway paths: api_kwargs passed directly, and stream_kwargs = {**api_kwargs}
    expect(calls).toContain("chat_completion_helpers.interruptible_api_call");
    expect(calls).toContain("chat_completion_helpers.interruptible_streaming_api_call");
    expect(descs.every((d) => d.kind === BoundaryKind.LLM)).toBe(true);
    // handle_max_iterations assembles summary_kwargs from literal keys -> not param-forwarded
    expect(calls).not.toContain("chat_completion_helpers.handle_max_iterations");
    expect(calls).not.toContain("chat_completion_helpers.run_inline_shell");
  });

  it("is pattern-based, not name-based: recognizes the seams after the functions are renamed", () => {
    // perturbation — rename both seam functions; the structural signals are unchanged
    const toolP = TOOL.replace(/handle_function_call/g, "dispatch_tool_xyz");
    const gwP = GATEWAY.replace(/interruptible_api_call/g, "do_llm_request");
    const td = new HermesAdapter().discover("model_tools.py", toolP);
    expect(td.map((d) => d.matchCall)).toEqual(["model_tools.dispatch_tool_xyz"]);
    const gd = new HermesAdapter().discover("chat_completion_helpers.py", gwP);
    expect(gd.map((d) => d.matchCall)).toContain("chat_completion_helpers.do_llm_request");
  });

  it("is authoritative: suppresses generic exec-sink / side-channel false positives", () => {
    const root = tmpRepo({ "model_tools.py": TOOL, "chat_completion_helpers.py": GATEWAY });
    const found = discover(root, undefined, [new HermesAdapter()]);
    const calls = found.map((d) => d.matchCall);
    expect(calls).toContain("model_tools.handle_function_call");
    expect(calls).toContain("chat_completion_helpers.interruptible_api_call");
    // the generic pack would flag run_inline_shell (exec sink) + handle_max_iterations; the
    // authoritative adapter owns discovery, so those never enter the config.
    expect(found.some((d) => d.matchCall.endsWith("run_inline_shell"))).toBe(false);
    expect(found.some((d) => d.matchCall.endsWith("handle_max_iterations"))).toBe(false);
  });
});

describe("discovery union with codebase adapters", () => {
  class StubAdapter extends CodebaseAdapter {
    readonly id = "stub";
    detect(): boolean {
      return true;
    }
    override discover(path: string, source: string): Descriptor[] {
      if (path.endsWith("svc.ts") && source.includes("MAGIC_DISPATCH")) {
        return [
          new Descriptor({
            id: "stub-dispatch",
            kind: BoundaryKind.AGENT_CALL,
            matchCall: "svc.dispatch",
            emitName: "svc.subagent.stub",
          }),
        ];
      }
      return [];
    }
  }

  it("unions the adapter's bespoke descriptors into Phase A (no python required)", () => {
    const root = tmpRepo({
      "svc.ts": "// MAGIC_DISPATCH\nexport function dispatch(task: string) { return task; }\n",
    });
    const withAdapter = discover(root, undefined, [new StubAdapter()]);
    expect(withAdapter.some((d) => d.matchCall === "svc.dispatch" && d.kind === "agent_call")).toBe(
      true,
    );
    // and without the adapter the bespoke boundary is not discovered
    const without = discover(root);
    expect(without.some((d) => d.matchCall === "svc.dispatch")).toBe(false);
  });
});

describe("registry: detect + repo-local proprietary loading", () => {
  it("detectAdapters returns the bundled openhands adapter for an openhands repo", async () => {
    const root = tmpRepo({ "svc.py": "from openhands.sdk import Agent\n" });
    const adapters = await detectAdapters(root);
    expect(adapters.some((a) => a.id === "openhands")).toBe(true);
  });

  it("loads a repo-local gigaphone.codebase.mjs (proprietary adapter) by convention", async () => {
    const root = mkdtempSync(join(tmpdir(), "gigaphone_local_"));
    // a self-contained proprietary adapter (duck-typed; would extend CodebaseAdapter in practice)
    writeFileSync(
      join(root, "gigaphone.codebase.mjs"),
      "export default class ArcanistAdapter {\n" +
        '  id = "arcanist";\n' +
        "  detect(repo) { return true; }\n" +
        "  scope() { return []; }\n" +
        "  discover() { return []; }\n" +
        "  redactionModel() { return [{ field: 'headers.authorization', reason: 'credentials' }]; }\n" +
        "  processBoundaries() { return []; }\n" +
        "}\n",
    );
    const local = await loadRepoAdapter(root);
    expect(local).not.toBeNull();
    expect(local!.id).toBe("arcanist");
    expect(local!.redactionModel()).toEqual([
      { field: "headers.authorization", reason: "credentials" },
    ]);
    const detected = await detectAdapters(root);
    expect(detected.some((a) => a.id === "arcanist")).toBe(true);
  });
});
