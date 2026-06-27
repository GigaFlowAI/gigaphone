/**
 * Generated documentation artifacts: report.md + architecture.md (DESIGN §12).
 *
 * Ported from tests/test_docs.py. The Python tests drive a real `verify_tree` over the python
 * testclient via a subprocess (the `flow` fixture) — that representative-run path is owned by
 * the parent's e2e suite. Here we exercise the *deterministic doc-string rendering* against
 * hand-built Plan / FixResult / TreeVerifyResult fixtures, asserting the same generated-string
 * invariants without launching a subprocess.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundaryKind, FailureMode } from "../src/core/boundary.js";
import { Descriptor, TreeVerifyResult, VerifyResult } from "../src/core/model.js";
import { PlanRecord } from "../src/core/planRecord.js";
import { FixResult } from "../src/engine/fix.js";
import { Plan, type Unresolved } from "../src/engine/plan.js";
import { render, renderArchitectureMd, renderReportMd, writeDocs } from "../src/engine/report.js";

function fixture() {
  const records = [
    new PlanRecord({
      boundary: "app/exec_tool.py:10",
      language: "python",
      providerOrFramework: "hand_rolled",
      kind: BoundaryKind.TOOL_EXEC,
      toolsCovered: ["run_code"],
      failureModes: [FailureMode.LOSSY_OUTPUT],
      completeOutputFields: ["stdout"],
    }),
    new PlanRecord({
      boundary: "app/gateway.py:5",
      language: "python",
      providerOrFramework: "anthropic",
      kind: BoundaryKind.LLM,
      failureModes: [FailureMode.UNTRACED],
    }),
  ];
  const unresolved: Unresolved[] = [
    { descriptorId: "agent-x", matchCall: "svc.dispatch", question: "which sub-agent?" },
  ];
  const plan = new Plan(records, unresolved);

  const fixResult = new FixResult();
  fixResult.edits.push({
    path: "app/exec_tool.py",
    hunks: [],
    description: "record complete tool output",
  });
  fixResult.skippedIdempotent = 1;

  const tree = new TreeVerifyResult(
    true,
    "agent",
    [
      new VerifyResult("run_code", true, true, true, "", "tool_exec"),
      new VerifyResult("web_search", true, true, true, "", "tool_exec"),
      new VerifyResult("fetch_url", true, true, true, "", "tool_exec"),
      new VerifyResult("llm", true, true, true, "", "llm"),
    ],
    [
      { requested: "run_code", linked: true },
      { requested: "web_search", linked: true },
      { requested: "fetch_url", linked: true },
    ],
  );

  const descriptors = [
    new Descriptor({
      id: "llm-gateway",
      kind: BoundaryKind.LLM,
      matchCall: "gateway.chat",
      emitName: "anthropic.llm",
      provider: "anthropic",
    }),
    new Descriptor({
      id: "run_code",
      kind: BoundaryKind.TOOL_EXEC,
      matchCall: "exec_tool.run_code",
    }),
    new Descriptor({
      id: "web_search",
      kind: BoundaryKind.TOOL_EXEC,
      matchCall: "web_tools.web_search",
    }),
    new Descriptor({
      id: "fetch_url",
      kind: BoundaryKind.TOOL_EXEC,
      matchCall: "web_tools.fetch_url",
    }),
  ];

  return { descriptors, plan, fixResult, tree };
}

describe("generated docs", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("test_report_md_outlines_problems_changes_and_verification", () => {
    const { plan, fixResult, tree } = fixture();
    const md = renderReportMd({
      harness: "cli",
      language: "python",
      backend: "otel",
      plan,
      fixResult,
      tree,
    });
    // the three required parts of the consolidated report
    expect(md).toContain("# GigaPhone");
    expect(md).toContain("## Problems found");
    expect(md).toContain("## Changes applied");
    expect(md).toContain("## Verification");
    // problems / verification name the boundary, kind, and failure mode
    expect(md).toContain("run_code");
    expect(md).toContain("lossy_output");
    // the llm gateway problem is outlined too
    expect(md.toLowerCase()).toContain("llm");
    // verification reports the coherent tree
    expect(md.toLowerCase()).toContain("single root");
  });

  it("test_architecture_md_describes_the_integrated_telemetry", () => {
    const { descriptors, plan, tree } = fixture();
    const md = renderArchitectureMd({
      harness: "cli",
      language: "python",
      backend: "otel",
      descriptors,
      plan,
      tree,
    });
    expect(md).toContain("# Telemetry Architecture");
    // the trace tree shape
    expect(md).toContain("agent");
    // every boundary's emit point is documented
    expect(md).toContain("run_code");
    expect(md).toContain("web_search");
    expect(md).toContain("fetch_url");
    // regression protection mentions the committed config
    expect(md).toContain("gigaphone.boundaries.yaml");
  });

  it("test_write_docs_commits_both_files_under_docs_gigaphone", () => {
    const { descriptors, plan, fixResult, tree } = fixture();
    const repo = mkdtempSync(join(tmpdir(), "gigaphone_docs_"));
    tmpDirs.push(repo);
    const paths = writeDocs(repo, {
      harness: "cli",
      language: "python",
      backend: "otel",
      descriptors,
      plan,
      fixResult,
      tree,
    });
    const reportPath = join(repo, "docs", "gigaphone", "report.md");
    const archPath = join(repo, "docs", "gigaphone", "architecture.md");
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(archPath)).toBe(true);
    expect(new Set(paths)).toEqual(new Set([reportPath, archPath]));
    // the written report carries the rendered content verbatim
    expect(readFileSync(reportPath, "utf-8")).toContain("# GigaPhone — Trace Coverage Report");
  });

  it("render() one-line summary counts boundaries and verified spans", () => {
    const { plan, tree } = fixture();
    const line = render({
      harness: "cli",
      language: "python",
      backend: "otel",
      plan,
      verifyResults: tree.results,
    });
    expect(line).toContain("Harness: cli · Language: python · Backend: otel");
    // 1 lossy tool-exec problem in the plan records
    expect(line).toContain("1 lossy");
    expect(line).toContain("Fixed + verified 4/4 spans");
    expect(line).toContain("Unresolved (resolution protocol): 1");
  });
});
