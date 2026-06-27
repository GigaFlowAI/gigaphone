/**
 * Native backend adapters (Braintrust + LangSmith — contextvars-native family; Logfire +
 * Arize/Phoenix — OTel family). Each is a thin OtelAdapter subclass: it reuses the family's
 * fix routing / expectations / verify and overrides only the vendor-divergent surface (id,
 * shim, detection, config, init).
 *
 * The Python-runtime shim lazy-fallback tests are intentionally skipped here: they exercise
 * `gigaphone.runtime.*.py`, which stay Python assets, not the TS engine.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BraintrustAdapter,
  LangSmithAdapter,
  LogfireAdapter,
  PhoenixAdapter,
  backendById,
  selectBackend,
} from "../src/adapters/backend/index.js";
import { BoundaryKind, FailureMode as FM } from "../src/core/boundary.js";
import { Boundary, Range } from "../src/core/model.js";

function boundary(): Boundary {
  return new Boundary({
    descriptorId: "tool-run",
    kind: BoundaryKind.TOOL_EXEC,
    path: "app/x.py",
    funcName: "run",
    call: "app.x.run",
    range: new Range("app/x.py", 0, 10, 1),
    completeOutputFields: ["stdout", "stderr", "exit_code"],
    toolsCovered: ["run"],
    emitName: "app.run",
    existingSpanName: "run",
  });
}

const NATIVES = [
  { Cls: BraintrustAdapter, id: "braintrust", shim: "gigaphone.runtime.braintrust" },
  { Cls: LangSmithAdapter, id: "langsmith", shim: "gigaphone.runtime.langsmith" },
  { Cls: LogfireAdapter, id: "logfire", shim: "gigaphone.runtime.logfire" },
  { Cls: PhoenixAdapter, id: "phoenix", shim: "gigaphone.runtime.phoenix" },
] as const;

describe("primitiveFor points at the native shim for all three failure modes", () => {
  for (const { Cls, id, shim } of NATIVES) {
    it(id, () => {
      const adapter = new Cls();
      const b = boundary();
      expect(adapter.id).toBe(id);

      const untraced = adapter.primitiveFor(b, FM.UNTRACED);
      expect(untraced.backendId).toBe(id);
      expect(untraced.importLine).toBe(`from ${shim} import gigaphone_trace`);
      expect(untraced.decorator).toBeTruthy();
      expect(untraced.decorator).toContain("gigaphone_trace(");

      const offCtx = adapter.primitiveFor(b, FM.OFF_CONTEXT);
      expect(offCtx.importLine).toBe(`from ${shim} import gigaphone_propagate`);
      expect(offCtx.executorWrapper).toBe("gigaphone_propagate");

      const lossy = adapter.primitiveFor(b, FM.LOSSY_OUTPUT);
      expect(lossy.importLine).toBe(`from ${shim} import gigaphone_complete`);
      expect(lossy.attrSetterTemplate).toBeTruthy();
      expect(lossy.attrSetterTemplate).toContain("gigaphone_complete(");
    });
  }
});

describe("expectationFor reuses the family keys", () => {
  for (const { Cls } of NATIVES) {
    it(new Cls().id, () => {
      const b = boundary();
      b.failureModes = [FM.UNTRACED];
      b.requiresCompleteAttrs = true;
      b.existingSpanName = null; // untraced boundary has no existing span; it gets emitName
      const exp = new Cls().expectationFor(b);
      expect(exp.spanName).toBe("app.run");
      expect(exp.requireAttrs).toEqual([
        "gigaphone.output.stdout",
        "gigaphone.output.stderr",
        "gigaphone.output.exit_code",
      ]);
    });
  }
});

describe("detectPresence scans for the SDK import", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gp_native_"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("contextvars-native + OTel-family adapters each detect their SDK", () => {
    writeFileSync(join(dir, "uses_bt.py"), "import braintrust\n");
    writeFileSync(join(dir, "uses_ls.py"), "from langsmith import traceable\n");
    writeFileSync(join(dir, "uses_logfire.py"), "import logfire\nlogfire.configure()\n");
    writeFileSync(join(dir, "uses_phoenix.py"), "from phoenix.otel import register\n");
    expect(new BraintrustAdapter().detectPresence(dir)).toBe(true);
    expect(new LangSmithAdapter().detectPresence(dir)).toBe(true);
    expect(new LogfireAdapter().detectPresence(dir)).toBe(true);
    expect(new PhoenixAdapter().detectPresence(dir)).toBe(true);
  });

  it("no false positives on a plain repo", () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "plain.py"), "import os\n");
    expect(new BraintrustAdapter().detectPresence(sub)).toBe(false);
    expect(new LangSmithAdapter().detectPresence(sub)).toBe(false);
    expect(new LogfireAdapter().detectPresence(sub)).toBe(false);
    expect(new PhoenixAdapter().detectPresence(sub)).toBe(false);
  });

  it("phoenix detects arize alone (and logfire does not)", () => {
    writeFileSync(join(dir, "app.py"), "from arize.otel import register\nregister()\n");
    expect(new PhoenixAdapter().detectPresence(dir)).toBe(true);
    expect(new LogfireAdapter().detectPresence(dir)).toBe(false);
  });
});

describe("vendor-native init snippets + config schemas", () => {
  it("braintrust init + config", () => {
    const init = new BraintrustAdapter().initSnippet({ project: "proj" });
    expect(init).toContain("import braintrust");
    expect(init).toContain("braintrust.init_logger(project='proj')");
    const schema = new BraintrustAdapter().configSchema();
    expect(schema).toHaveProperty("project");
    expect(schema).toHaveProperty("api_key");
  });

  it("langsmith init + config", () => {
    const init = new LangSmithAdapter().initSnippet({});
    expect(init).toContain("import langsmith");
    expect(init).toContain("langsmith.Client()");
    expect(new LangSmithAdapter().configSchema()).toHaveProperty("project");
  });

  it("logfire init is logfire.configure(...) and config exposes token", () => {
    const init = new LogfireAdapter().initSnippet({ service_name: "svc" });
    expect(init).toContain("import logfire");
    expect(init).toContain("logfire.configure(");
    expect(init).toContain("service_name='svc'");
    expect(new LogfireAdapter().configSchema()).toHaveProperty("token");
  });

  it("phoenix init uses phoenix.otel.register(...) and config exposes endpoint+project", () => {
    const init = new PhoenixAdapter().initSnippet({ project: "proj" });
    expect(init).toContain("from phoenix.otel import register");
    expect(init).toContain("register(");
    const schema = new PhoenixAdapter().configSchema();
    expect(schema).toHaveProperty("endpoint");
    expect(schema).toHaveProperty("project");
  });
});

describe("registry exposes + selects each native adapter", () => {
  for (const { Cls, id } of NATIVES) {
    it(`${id} by id + preferred`, () => {
      expect(backendById(id)).toBeInstanceOf(Cls);
      expect(selectBackend(tmpdir(), id)).toBeInstanceOf(Cls);
    });
  }

  it("falls back to otel when no native SDK is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "gp_plain_"));
    writeFileSync(join(dir, "app.py"), "import os\n");
    expect(selectBackend(dir).id).toBe("otel");
    rmSync(dir, { recursive: true, force: true });
  });

  it("selectBackend detects a logfire / phoenix / braintrust repo", () => {
    for (const [src, Cls] of [
      ["import logfire\nlogfire.configure()\n", LogfireAdapter],
      ["from phoenix.otel import register\nregister()\n", PhoenixAdapter],
      ["import braintrust\n", BraintrustAdapter],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), "gp_sel_"));
      writeFileSync(join(dir, "app.py"), src);
      expect(selectBackend(dir)).toBeInstanceOf(Cls);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
