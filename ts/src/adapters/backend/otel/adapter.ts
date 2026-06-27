/**
 * Generic OTel / OpenInference backend adapter (DESIGN §9).
 *
 * The two-tier default: targets any OTLP backend with no code change (new platform = endpoint
 * + headers). Supplies the vendor-specific *pieces* of each fix (which import, which
 * decorator/wrapper/setter); the language pack decides placement. `verify` reads the exported
 * spans — the same read path the eval platform uses (DESIGN §12, ADR-0005).
 *
 * The engine is TypeScript but instruments target codebases in their own language; `verify`
 * launches the target runtime (`python3 -m <module>` for Python, `node <entry>` for TS) which
 * imports the language-specific runtime shim and writes spans as JSONL to GIGAPHONE_SPAN_FILE.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  type Dirent,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { LLM_CONVENTION_ATTRS } from "../../../core/boundary.js";
import { BoundaryKind, type FailureMode, FailureMode as FM } from "../../../core/boundary.js";
import {
  type Boundary,
  type Expectation,
  expectation,
  type FixPrimitive,
  TreeVerifyResult,
  VerifyResult,
} from "../../../core/model.js";
import { BackendAdapter, type VerifyProject } from "../../../interfaces/backendAdapter.js";

/** Python repr() of a string: single-quoted with backslash/quote escaping. */
function pyRepr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

interface Pieces {
  importLine: string;
  decorator?: string;
  executorWrapper?: string;
  attrSetterTemplate?: string;
}

/**
 * Render a backend primitive's language-specific *pieces* (import line + call sites). The
 * backend owns semantics (which shim, which span kind); this owns the per-language syntax.
 */
function renderPieces(
  lang: string,
  shim: string,
  mode: FailureMode,
  name: string,
  spanKind: string,
  fields: string[],
): Pieces {
  if (lang === "typescript") {
    if (mode === FM.UNTRACED) {
      const f = fields.map((x) => `"${x}"`).join(", ");
      return {
        importLine: `import { gigaphoneTrace } from "${shim}";`,
        decorator: `gigaphoneTrace({ name: "${name}", kind: "${spanKind}", output: [${f}] })`,
      };
    }
    if (mode === FM.OFF_CONTEXT) {
      return {
        importLine: `import { gigaphonePropagate } from "${shim}";`,
        executorWrapper: "gigaphonePropagate",
      };
    }
    if (mode === FM.LOSSY_OUTPUT) {
      return {
        importLine: `import { gigaphoneComplete } from "${shim}";`,
        attrSetterTemplate: "gigaphoneComplete({span}, {value}, {fields});",
      };
    }
    throw new Error(`no OTel primitive for ${mode} (introduce-a-boundary is advisory)`);
  }

  // python (default)
  if (mode === FM.UNTRACED) {
    const f = fields.map(pyRepr).join(", ");
    return {
      importLine: `from ${shim} import gigaphone_trace`,
      decorator: `gigaphone_trace(name="${name}", kind="${spanKind}", output=[${f}])`,
    };
  }
  if (mode === FM.OFF_CONTEXT) {
    return {
      importLine: `from ${shim} import gigaphone_propagate`,
      executorWrapper: "gigaphone_propagate",
    };
  }
  if (mode === FM.LOSSY_OUTPUT) {
    return {
      importLine: `from ${shim} import gigaphone_complete`,
      attrSetterTemplate: "gigaphone_complete({span}, {value}, fields={fields})",
    };
  }
  throw new Error(`no OTel primitive for ${mode} (introduce-a-boundary is advisory)`);
}

interface RawSpan {
  span_id: string;
  parent_id: string | null;
  name: string;
  attributes?: Record<string, unknown>;
}

export class OtelAdapter extends BackendAdapter {
  readonly id: string = "otel";
  /** The runtime shim each emitted fix imports, per language. Native adapters override this. */
  shimPackages: Record<string, string> = {
    python: "gigaphone.runtime.otel",
    typescript: "@gigaphone/otel",
  };

  // --- detection / config ---------------------------------------------------------
  detectPresence(repo: string): boolean {
    return scanForAny(repo, [".py"], (t) => t.includes("opentelemetry") || t.includes("openinference"));
  }

  configSchema(): Record<string, string> {
    return {
      endpoint: "OTLP endpoint URL",
      headers: "OTLP headers (auth)",
      service_name: "logical service name",
    };
  }

  initSnippet(config: Record<string, string>): string {
    const ep = config.endpoint ?? "${OTEL_EXPORTER_OTLP_ENDPOINT}";
    return (
      "from opentelemetry import trace\n" +
      "from opentelemetry.sdk.trace import TracerProvider\n" +
      "from opentelemetry.sdk.trace.export import BatchSpanProcessor\n" +
      "from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter\n" +
      "provider = TracerProvider()\n" +
      `provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=${pyRepr(ep)})))\n` +
      "trace.set_tracer_provider(provider)\n"
    );
  }

  // --- fix primitives (one per failure mode) --------------------------------------
  primitiveFor(boundary: Boundary, mode: FailureMode, lang = "python"): FixPrimitive {
    if (boundary.kind === BoundaryKind.LLM) return this.llmPrimitive(boundary, mode, lang);
    const shim = this.shimPackages[lang] ?? this.shimPackages.python!;
    const name = boundary.emitName ?? `${boundary.providerOrFramework}.${boundary.funcName}`;
    const spanKind = boundary.kind === BoundaryKind.AGENT_CALL ? "agent" : "tool";
    if (mode === FM.UNTRACED) {
      const r = renderPieces(lang, shim, mode, name, spanKind, boundary.completeOutputFields);
      return {
        failureMode: mode,
        backendId: this.id,
        importLine: r.importLine,
        emitName: name,
        outputFields: [...boundary.completeOutputFields],
        decorator: r.decorator,
      };
    }
    if (mode === FM.OFF_CONTEXT) {
      const r = renderPieces(lang, shim, mode, name, spanKind, boundary.completeOutputFields);
      return {
        failureMode: mode,
        backendId: this.id,
        importLine: r.importLine,
        emitName: boundary.existingSpanName ?? boundary.funcName,
        executorWrapper: r.executorWrapper,
      };
    }
    if (mode === FM.LOSSY_OUTPUT) {
      const r = renderPieces(lang, shim, mode, name, spanKind, boundary.completeOutputFields);
      return {
        failureMode: mode,
        backendId: this.id,
        importLine: r.importLine,
        emitName: boundary.existingSpanName ?? boundary.funcName,
        outputFields: [...boundary.completeOutputFields],
        attrSetterTemplate: r.attrSetterTemplate,
      };
    }
    throw new Error(`no OTel primitive for ${mode} (introduce-a-boundary is advisory)`);
  }

  /** LLM-boundary fixes (Approach A, Path 2 hand-rolled). */
  protected llmPrimitive(boundary: Boundary, mode: FailureMode, lang = "python"): FixPrimitive {
    const shim = this.shimPackages[lang] ?? this.shimPackages.python!;
    const name =
      boundary.existingSpanName ?? boundary.emitName ?? `${boundary.providerOrFramework}.llm`;
    if (mode === FM.LOSSY_OUTPUT) {
      return {
        failureMode: mode,
        backendId: this.id,
        importLine: `from ${shim} import gigaphone_llm_complete`,
        emitName: name,
      };
    }
    if (mode === FM.UNTRACED) {
      const attr = boundary.llmModelAttr;
      const arg = boundary.llmMessagesArg ?? "messages";
      const emit = boundary.emitName ?? `${boundary.providerOrFramework}.llm`;
      const attrRepr = attr === null || attr === undefined ? "None" : pyRepr(attr);
      const decorator = `gigaphone_llm_trace(name="${emit}", model_attr=${attrRepr}, messages_arg=${pyRepr(arg)})`;
      return {
        failureMode: mode,
        backendId: this.id,
        importLine: `from ${shim} import gigaphone_llm_trace`,
        emitName: emit,
        decorator,
      };
    }
    if (mode === FM.OFF_CONTEXT) {
      return {
        failureMode: mode,
        backendId: this.id,
        importLine: `from ${shim} import gigaphone_propagate`,
        emitName: name,
        executorWrapper: "gigaphone_propagate",
      };
    }
    throw new Error(`no OTel LLM primitive for ${mode}`);
  }

  /** Path 1: the import + init lines that enable a recognized provider's OpenInference instrumentor. */
  enableLlmInstrumentation(provider: string): [string, string] {
    const cls = (
      { openai: "OpenAIInstrumentor", anthropic: "AnthropicInstrumentor", langchain: "LangChainInstrumentor" } as Record<string, string>
    )[provider];
    if (cls === undefined)
      throw new Error(`no OpenInference instrumentor known for provider ${pyRepr(provider)}`);
    const module = `openinference.instrumentation.${provider}`;
    return [`from ${module} import ${cls}`, `${cls}().instrument()`];
  }

  expectationFor(boundary: Boundary): Expectation {
    if (boundary.kind === BoundaryKind.LLM) {
      const spanName = boundary.existingSpanName ?? boundary.emitName ?? boundary.funcName;
      const attrs = boundary.requiresLlmConvention ? [...LLM_CONVENTION_ATTRS] : [];
      return expectation(boundary.funcName, spanName, { requireNested: true, requireAttrs: attrs, kind: "llm" });
    }
    const tool = boundary.toolsCovered.length ? boundary.toolsCovered[0]! : boundary.funcName;
    const spanName = boundary.existingSpanName ?? boundary.emitName ?? boundary.funcName;
    if (boundary.kind === BoundaryKind.AGENT_CALL) {
      return expectation(tool, spanName, { requireNested: true, requireAttrs: [] });
    }
    const attrs = boundary.requiresCompleteAttrs
      ? boundary.completeOutputFields.map((f) => `gigaphone.output.${f}`)
      : [];
    return expectation(tool, spanName, { requireNested: true, requireAttrs: attrs });
  }

  // --- verification (the read path the eval platform uses) ------------------------
  verify(project: VerifyProject, run: Expectation[]): VerifyResult[] {
    const spans = runAndCapture(project);
    const byId = new Map(spans.map((s) => [s.span_id, s]));
    const roots = spans.filter((s) => s.parent_id === null || s.parent_id === undefined);
    const agent = roots.find((s) => s.name === "agent") ?? roots[0] ?? null;
    const agentId = agent ? agent.span_id : null;

    const results: VerifyResult[] = [];
    for (const exp of run) {
      const matches = spans.filter((s) => s.name === exp.spanName);
      if (matches.length === 0) {
        results.push(new VerifyResult(exp.tool, false, false, false, "span not found", exp.kind));
        continue;
      }
      results.push(evaluate([matches[matches.length - 1]!], exp, agentId, byId));
    }
    return results;
  }

  verifyTree(project: VerifyProject, run: Expectation[]): TreeVerifyResult {
    const spans = runAndCapture(project);
    const byId = new Map(spans.map((s) => [s.span_id, s]));
    const roots = spans.filter((s) => s.parent_id === null || s.parent_id === undefined);
    const singleRoot = roots.length === 1;
    const agent = roots.find((s) => s.name === "agent") ?? roots[0] ?? null;
    const agentId = agent ? agent.span_id : null;
    const rootName = agent ? agent.name : null;

    const results = run.map((exp) =>
      evaluate(spans.filter((s) => s.name === exp.spanName), exp, agentId, byId),
    );

    const toolCallsText = spans
      .map((s) => String((s.attributes ?? {})["llm.tool_calls"] ?? ""))
      .join(" ");
    const okTools = new Set(results.filter((r) => r.ok && r.kind !== "llm").map((r) => r.tool));
    const linkage = run
      .filter((exp) => exp.kind !== "llm")
      .map((exp) => ({
        requested: exp.tool,
        linked: toolCallsText.includes(exp.tool) && okTools.has(exp.tool),
      }));
    return new TreeVerifyResult(singleRoot, rootName, results, linkage);
  }

  // interface fix-primitive stubs (delegate to primitiveFor in practice) ---
  detectFramework(): null {
    return null;
  }
}

function evaluate(
  matches: RawSpan[],
  exp: Expectation,
  agentId: string | null,
  byId: Map<string, RawSpan>,
): VerifyResult {
  if (matches.length === 0)
    return new VerifyResult(exp.tool, false, false, false, "span not found", exp.kind);
  const nested = matches.every((s) => !exp.requireNested || isDescendant(s, agentId, byId));
  const missing = new Set<string>();
  for (const s of matches)
    for (const a of exp.requireAttrs) if (!(a in (s.attributes ?? {}))) missing.add(a);
  const missingSorted = [...missing].sort();
  const complete = missingSorted.length === 0;
  const problems: string[] = [];
  if (!nested) problems.push("orphan");
  if (missingSorted.length) problems.push(`missing ${missingSorted.join(",")}`);
  return new VerifyResult(exp.tool, true, nested, complete, problems.join(" "), exp.kind);
}

function isDescendant(span: RawSpan, ancestorId: string | null, byId: Map<string, RawSpan>): boolean {
  const seen = new Set<string>();
  let cur: RawSpan | undefined = span;
  while (cur !== undefined && !seen.has(cur.span_id)) {
    seen.add(cur.span_id);
    const pid: string | null = cur.parent_id;
    if (pid === ancestorId) return true;
    cur = pid === null || pid === undefined ? undefined : byId.get(pid);
  }
  return false;
}

/**
 * Run the representative path and read back the spans it exported as JSONL. Language-neutral
 * on the read side; only the launch differs — `python3 -m <module>` for Python, `node <entry>`
 * for TypeScript (Node resolves `@gigaphone/*` from the project's own node_modules).
 */
function runAndCapture(project: VerifyProject): RawSpan[] {
  const repo = project.repo;
  const module = project.module ?? "app.run_representative";
  const root = project.root ?? repo;
  const lang = project.lang ?? "python";
  const entry = project.entry;

  const dir = mkdtempSync(join(tmpdir(), "gigaphone_spans_"));
  const spanFile = join(dir, "spans.jsonl");
  closeSync(openSync(spanFile, "w"));
  const env: NodeJS.ProcessEnv = { ...process.env, GIGAPHONE_SPAN_FILE: spanFile };

  let argv: string[];
  if (lang === "typescript") {
    argv = ["node", entry ?? "run_representative.mjs"];
  } else {
    env.PYTHONPATH = [root, env.PYTHONPATH ?? ""].filter(Boolean).join(delimiter);
    argv = [pythonExe(), "-m", module];
  }
  const proc = spawnSync(argv[0]!, argv.slice(1), {
    cwd: repo,
    env,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (proc.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`representative path failed:\n${proc.stderr}`);
  }
  const spans: RawSpan[] = [];
  for (const line of readFileSync(spanFile, "utf-8").split("\n")) {
    const t = line.trim();
    if (t) spans.push(JSON.parse(t) as RawSpan);
  }
  rmSync(dir, { recursive: true, force: true });
  return spans;
}

function pythonExe(): string {
  return process.env.GIGAPHONE_PYTHON ?? "python3";
}

/** Walk files with the given extensions under root; true if any matches the predicate. */
function scanForAny(root: string, exts: string[], pred: (text: string) => boolean): boolean {
  const stack = [root];
  const SKIP = new Set([".git", ".venv", "venv", "node_modules", "__pycache__"]);
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(p);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        try {
          if (pred(readFileSync(p, "utf-8"))) return true;
        } catch {
          // ignore unreadable
        }
      }
    }
  }
  return false;
}

export { runAndCapture, scanForAny };
