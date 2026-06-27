/**
 * LLM boundary discovery, classification, and fix emission (Python pack). Ported from
 * tests/test_llm_classification.py + tests/test_llm_fix.py. Calls the pack directly and
 * builds the FixPrimitive literals the otel adapter would have produced (no adapter dep).
 */

import { describe, expect, it } from "vitest";
import { BoundaryKind, FailureMode } from "../src/core/boundary.js";
import type { Boundary, FixPrimitive } from "../src/core/model.js";
import { PythonPack } from "../src/packs/python/index.js";

const HAND_ROLLED = `from app.tracing import tracer

class LLMGateway:
    model = "acme-1"
    def chat(self, messages):
        with tracer().start_as_current_span("llm") as span:
            span.set_attribute("llm.model", self.model)
            reply = self._next(messages)
            return reply
`;

const SDK = `import openai

client = openai.OpenAI()

def call_model(messages):
    return client.chat.completions.create(model="gpt-4o", messages=messages)
`;

const UNTRACED_HAND_ROLLED = `class ModelClient:
    model = "acme-1"
    def generate(self, messages):
        return {"content": "hi"}
`;

function discoverByCall(pack: PythonPack, path: string, src: string) {
  const map = new Map<string, ReturnType<PythonPack["discover"]>[number]>();
  for (const d of pack.discover(path, src)) map.set(d.matchCall, d);
  return map;
}

function boundaryByFunc(src: string, func: string): Boundary {
  const pack = new PythonPack();
  const descs = pack.discover("app/g.py", src);
  const map = new Map<string, Boundary>();
  for (const b of pack.analyze("app/g.py", src, descs)) map.set(b.funcName, b);
  const b = map.get(func);
  if (!b) throw new Error(`no boundary for ${func}`);
  return b;
}

describe("LLM gateway discovery + provider tagging", () => {
  it("tags a hand-rolled gateway hand_rolled", () => {
    const pack = new PythonPack();
    const d = discoverByCall(pack, "app/gateway.py", HAND_ROLLED).get(
      "app.gateway.LLMGateway.chat",
    );
    expect(d?.kind).toBe(BoundaryKind.LLM);
    expect(d?.provider).toBe("hand_rolled");
  });

  it("tags an openai-SDK gateway openai", () => {
    const pack = new PythonPack();
    const d = discoverByCall(pack, "app/llm.py", SDK).get("app.llm.call_model");
    expect(d?.kind).toBe(BoundaryKind.LLM);
    expect(d?.provider).toBe("openai");
  });
});

describe("LLM classification", () => {
  it("classifies a span missing the convention as lossy_output", () => {
    const pack = new PythonPack();
    const descs = pack.discover("app/gateway.py", HAND_ROLLED);
    const byFunc = new Map<string, Boundary>();
    for (const b of pack.analyze("app/gateway.py", HAND_ROLLED, descs)) byFunc.set(b.funcName, b);
    expect(byFunc.get("chat")?.failureModes).toEqual([FailureMode.LOSSY_OUTPUT]);
  });

  it("classifies an untraced hand-rolled gateway as untraced", () => {
    const pack = new PythonPack();
    const descs = pack.discover("app/client.py", UNTRACED_HAND_ROLLED);
    const byFunc = new Map<string, Boundary>();
    for (const b of pack.analyze("app/client.py", UNTRACED_HAND_ROLLED, descs))
      byFunc.set(b.funcName, b);
    expect(byFunc.get("generate")?.failureModes).toEqual([FailureMode.UNTRACED]);
  });
});

describe("LLM fix emission", () => {
  it("lossy LLM fix inserts a gigaphone_llm_complete call", () => {
    const pack = new PythonPack();
    const b = boundaryByFunc(HAND_ROLLED, "chat");
    // otel adapter's LLM lossy primitive
    const prim: FixPrimitive = {
      failureMode: FailureMode.LOSSY_OUTPUT,
      backendId: "otel",
      importLine: "from gigaphone.runtime.otel import gigaphone_llm_complete",
      emitName: b.existingSpanName ?? b.emitName ?? `${b.providerOrFramework}.llm`,
    };
    const edit = pack.emitFix(b, prim, HAND_ROLLED);
    expect(edit).not.toBeNull();
    const text = edit?.hunks.map((h) => h.newText).join("") ?? "";
    expect(text).toContain("gigaphone_llm_complete");
    expect(text).toContain("messages=messages");
    expect(text).toContain("response=reply");
    expect(text).toContain("model=self.model");
    // it must NOT fall back to the tool-output shim
    expect(text).not.toContain("gigaphone.output");
  });

  it("untraced LLM fix wraps with the gigaphone_llm_trace decorator", () => {
    const pack = new PythonPack();
    const b = boundaryByFunc(UNTRACED_HAND_ROLLED, "generate");
    // otel adapter's LLM untraced primitive
    const attr = b.llmModelAttr; // null here -> repr None
    const arg = b.llmMessagesArg ?? "messages";
    const emit = b.emitName ?? `${b.providerOrFramework}.llm`;
    const reprAttr = attr === null ? "None" : `'${attr}'`;
    const prim: FixPrimitive = {
      failureMode: FailureMode.UNTRACED,
      backendId: "otel",
      importLine: "from gigaphone.runtime.otel import gigaphone_llm_trace",
      emitName: emit,
      decorator: `gigaphone_llm_trace(name="${emit}", model_attr=${reprAttr}, messages_arg='${arg}')`,
    };
    const edit = pack.emitFix(b, prim, UNTRACED_HAND_ROLLED);
    expect(edit).not.toBeNull();
    const text = edit?.hunks.map((h) => h.newText).join("") ?? "";
    expect(text).toContain("gigaphone_llm_trace");
    expect(text).toContain("messages_arg='messages'");
  });
});
