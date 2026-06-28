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
});
