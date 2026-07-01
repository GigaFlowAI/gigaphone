/**
 * Generic lifecycle hook-bus tool-boundary discovery (Python pack). A harness that fires a
 * named `*tool_call*` observer hook with the tool result is reporting a tool-execution
 * boundary that dotted-call matching misses (dispatch goes through a registry/middleware). The
 * pack recognizes it language-neutrally — without any codebase adapter.
 */

import { describe, expect, it } from "vitest";
import { PythonPack } from "../src/packs/python/index.js";

const pack = new PythonPack();
const calls = (src: string) => pack.discover("model_tools.py", src).map((d) => `${d.kind}:${d.matchCall}`);

// emitter helper fires the hook; the dispatcher that calls it is the boundary (indirection).
const INDIRECT = `def _emit_post_tool_call_hook(*, function_name, result):
    invoke_hook("post_tool_call", tool_name=function_name, result=result)

def handle_function_call(function_name, function_args):
    result = registry.dispatch(function_name, function_args)
    _emit_post_tool_call_hook(function_name=function_name, result=result)
    return result
`;

// a function that fires the tool-call hook directly is itself the boundary.
const DIRECT = `def run_tool(name, args):
    result = _registry.dispatch(name, args)
    invoke_hook("post_tool_call", tool_name=name, result=result)
    return result
`;

// distractor: a generation-progress signal ("tool_gen"), NOT the tool_call consumption hook.
const DISTRACTOR = `def _fire_tool_gen_started(name):
    notify_hook("tool_gen_started", tool=name)

def stream_completion(messages):
    _fire_tool_gen_started("x")
    return client.chat.completions.create(messages=messages, stream=True)
`;

// Cross-framework shapes (verified against the real repos, not invented):
//  LangChain: BaseTool.run fires run_manager.on_tool_end(...) — event in the METHOD NAME.
const LANGCHAIN = `class BaseTool:
    def run(self, tool_input, run_manager):
        run_manager.on_tool_start(tool_input)
        observation = self._run(tool_input)
        run_manager.on_tool_end(observation)
        return observation
`;
//  LlamaIndex: fires on_event_start(CBEventType.FUNCTION_CALL, ...) — event in an ENUM arg.
const LLAMAINDEX = `def call(self, *args, **kwargs):
    self.callback_manager.on_event_start(CBEventType.FUNCTION_CALL, payload={"tool": self})
    out = self._fn(*args, **kwargs)
    self.callback_manager.on_event_end(CBEventType.FUNCTION_CALL, payload={"result": out})
    return out
`;
//  PydanticAI: fires capability hooks `before_tool_execute` / `after_tool_execute` (the
//  `tool_execute` variant + a distinct verb vocabulary — held-out, not used to design the rule).
const PYDANTIC = `def _run_execute_hooks(self, validated, usage):
    cap = self.root_capability
    args = cap.before_tool_execute(ctx, call=call, args=validated.validated_args)
    tool_result = cap.wrap_tool_execute(ctx, call=call, args=args, handler=do_execute)
    tool_result = cap.after_tool_execute(ctx, call=call, args=args, result=tool_result)
    return tool_result
`;
//  a harness that executes a tool with NO observer hook — the recognizer must abstain here.
const NO_HOOK = `def just_run_it(name, args):
    return _registry.dispatch(name, args)
`;

describe("generic hook-bus tool boundary", () => {
  it("finds the dispatcher behind an emitter helper, not the emitter itself", () => {
    const found = calls(INDIRECT);
    expect(found).toContain("tool_exec:model_tools.handle_function_call");
    // the thin emitter helper is not a consumption boundary
    expect(found.some((c) => c.includes("_emit_post_tool_call_hook"))).toBe(false);
  });

  it("finds a function that fires the post_tool_call hook directly", () => {
    expect(calls(DIRECT)).toContain("tool_exec:model_tools.run_tool");
  });

  it("does not match a tool-generation-progress signal (only the tool_call lifecycle)", () => {
    const found = calls(DISTRACTOR);
    // stream_completion calls _fire_tool_gen_started (a 'tool_gen' event) — not a tool_call hook
    expect(found.some((c) => c.includes("tool_exec") && c.includes("stream_completion"))).toBe(false);
    expect(found.some((c) => c.includes("tool_exec") && c.includes("_fire_tool_gen_started"))).toBe(false);
  });

  // cross-framework transfer: the same recognizer handles other harnesses' hook shapes,
  // verified against the real LangChain / LlamaIndex source (not just Hermes).
  it("transfers to LangChain's on_tool_end method-name shape (finds run)", () => {
    expect(calls(LANGCHAIN)).toContain("tool_exec:model_tools.run");
  });

  it("transfers to LlamaIndex's on_event_start(FUNCTION_CALL) enum-arg shape (finds call)", () => {
    expect(calls(LLAMAINDEX)).toContain("tool_exec:model_tools.call");
  });

  it("transfers to PydanticAI's before/after_tool_execute capability-hook shape", () => {
    expect(calls(PYDANTIC)).toContain("tool_exec:model_tools._run_execute_hooks");
  });

  it("abstains when a tool runs with no observer hook (no false positive)", () => {
    expect(calls(NO_HOOK).some((c) => c.startsWith("tool_exec"))).toBe(false);
  });
});
