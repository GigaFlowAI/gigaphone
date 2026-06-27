/**
 * Onboarding report (DESIGN §12) — the user-facing acceptance artifact.
 *
 * Two surfaces: the one-line `render` summary, and the committed markdown artifacts
 * `report.md` (problems + changes + verification) and `architecture.md` (the integrated
 * telemetry architecture). The markdown is deterministic — built from the plan, the applied
 * fixes, and the verified tree, with no model call (this feature).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoundaryKind, FailureMode } from "../core/boundary.js";
import type { Descriptor, TreeVerifyResult, VerifyResult } from "../core/model.js";
import type { FixResult } from "./fix.js";
import type { Plan } from "./plan.js";

// why each failure mode loses telemetry — the rationale shown in report.md.
const _WHY: Record<string, string> = {
  [FailureMode.UNTRACED]: "the boundary has no span, so its output never reaches the trace",
  [FailureMode.OFF_CONTEXT]:
    "the span is created off the agent's context, so it lands in a " +
    "detached/orphan trace the eval platform can't see",
  [FailureMode.LOSSY_OUTPUT]:
    "the span records only a partial/truncated payload, losing the " +
    "complete result (for an llm span: the OpenInference convention)",
  [FailureMode.NO_BOUNDARY]:
    "execution is inlined/scattered with no single consumption layer to trace",
};

export interface RenderOpts {
  harness: string;
  language: string;
  backend: string;
  plan: Plan;
  verifyResults: VerifyResult[];
  traceLink?: string | null;
}

export function render(opts: RenderOpts): string {
  const { harness, language, backend, plan, verifyResults, traceLink = null } = opts;
  const boundaries = plan.records.filter((r) => r.kind === "tool_exec" || r.kind === "agent_call");
  const counts: Record<string, number> = {
    [FailureMode.NO_BOUNDARY]: 0,
    [FailureMode.UNTRACED]: 0,
    [FailureMode.OFF_CONTEXT]: 0,
    [FailureMode.LOSSY_OUTPUT]: 0,
  };
  for (const r of plan.records) for (const m of r.failureModes) counts[m] = (counts[m] ?? 0) + 1;
  const verified = verifyResults.filter((v) => v.ok).length;
  const parts: string[] = [
    `Harness: ${harness} · Language: ${language} · Backend: ${backend}`,
    `${boundaries.length} boundaries · ` +
      `${counts[FailureMode.UNTRACED]} untraced · ` +
      `${counts[FailureMode.OFF_CONTEXT]} off-context · ` +
      `${counts[FailureMode.LOSSY_OUTPUT]} lossy` +
      (counts[FailureMode.NO_BOUNDARY] ? ` · ${counts[FailureMode.NO_BOUNDARY]} no-boundary` : ""),
    `Fixed + verified ${verified}/${verifyResults.length} spans (nested + complete).`,
  ];
  for (const v of verifyResults) {
    const mark = v.ok ? "✓" : "✗";
    parts.push(`  ${mark} ${v.tool}: ${v.ok ? "nested + complete" : v.detail}`);
  }
  if (plan.unresolved.length) {
    parts.push(`Unresolved (resolution protocol): ${plan.unresolved.length}`);
  }
  if (traceLink) parts.push(`Verified trace: ${traceLink}`);
  return parts.join("\n");
}

function _mechanism(kind: BoundaryKind, provider: string | null): string {
  if (kind === BoundaryKind.LLM) {
    if (provider && provider !== "hand_rolled") {
      return `${provider} OpenInference instrumentor (Path 1)`;
    }
    return "gigaphone llm span — OpenInference convention (Path 2, hand-rolled)";
  }
  return "gigaphone tool span (complete output recorded)";
}

export interface RenderReportMdOpts {
  harness: string;
  language: string;
  backend: string;
  plan: Plan;
  fixResult: FixResult;
  tree: TreeVerifyResult;
  traceLink?: string | null;
}

export function renderReportMd(opts: RenderReportMdOpts): string {
  const { harness, language, backend, plan, fixResult, tree, traceLink = null } = opts;
  const lines: string[] = [
    "# GigaPhone — Trace Coverage Report",
    "",
    `**Harness:** ${harness} · **Language:** ${language} · **Backend:** ${backend}`,
    "",
    "## Problems found",
    "",
  ];
  const problems = plan.records.filter((r) => r.failureModes.length);
  if (problems.length) {
    lines.push("| Boundary | Kind | Failure mode | Why it loses telemetry |");
    lines.push("|---|---|---|---|");
    for (const r of problems) {
      const modes = r.failureModes.join(", ");
      const why = r.failureModes.map((m) => _WHY[m] ?? "").join("; ");
      lines.push(`| \`${r.boundary}\` | ${r.kind} | ${modes} | ${why} |`);
    }
  } else {
    lines.push("_No coverage gaps detected._");
  }
  if (plan.unresolved.length) {
    lines.push("");
    lines.push(
      `> ${plan.unresolved.length} boundary(ies) could not be localized automatically and ` +
        "were surfaced via the resolution protocol (never silently skipped).",
    );
  }

  lines.push("", "## Changes applied", "");
  if (fixResult.edits.length) {
    for (const edit of fixResult.edits) {
      lines.push(`- **\`${edit.path}\`** — ${edit.description}`);
    }
    if (fixResult.skippedIdempotent) {
      lines.push(
        `- _(skipped ${fixResult.skippedIdempotent} already-applied edit(s) — fixes ` +
          "are idempotent)_",
      );
    }
  } else {
    lines.push("_No edits required._");
  }

  lines.push("", "## Verification", "");
  lines.push(`- **Single root:** ${tree.singleRoot ? "yes ✓" : "no ✗"} (\`${tree.rootSpanName}\`)`);
  lines.push("");
  lines.push("| Span | Kind | Found | Nested | Complete |");
  lines.push("|---|---|---|---|---|");
  for (const r of tree.results) {
    const mark = (b: boolean) => (b ? "✓" : "✗");
    const detail = r.detail ? ` — ${r.detail}` : "";
    lines.push(
      `| ${r.tool} | ${r.kind} | ${mark(r.found)} | ${mark(r.nested)} | ` +
        `${mark(r.complete)}${detail} |`,
    );
  }
  if (tree.linkage.length) {
    lines.push("", "**Causal linkage (model tool request → tool span):**", "");
    for (const link of tree.linkage) {
      lines.push(`- \`${link.requested}\` → ${link.linked ? "linked ✓" : "NOT linked ✗"}`);
    }
  }
  lines.push("", `**Result:** ${tree.ok ? "all telemetry verified ✓" : "gaps remain ✗"}`);
  if (traceLink) lines.push(`\nVerified trace: ${traceLink}`);
  return lines.join("\n") + "\n";
}

export interface RenderArchitectureMdOpts {
  harness: string;
  language: string;
  backend: string;
  descriptors: Descriptor[];
  plan: Plan;
  tree: TreeVerifyResult;
}

export function renderArchitectureMd(opts: RenderArchitectureMdOpts): string {
  const { harness, language, backend, descriptors, tree } = opts;
  const llm = descriptors.filter((d) => d.kind === BoundaryKind.LLM);
  const tools = descriptors.filter((d) => d.kind === BoundaryKind.TOOL_EXEC);
  const root = tree.rootSpanName || "agent";

  const lines: string[] = [
    "# Telemetry Architecture",
    "",
    "The instrumentation GigaPhone integrated into this codebase. Generated from the " +
      "committed boundary config and the verified trace — regenerate after any change.",
    "",
    `**Harness:** ${harness} · **Language:** ${language} · **Backend:** ${backend}`,
    "",
    "## Trace tree",
    "",
    "Every LLM call and tool execution is a span nested under the agent root:",
    "",
    "```",
    root,
  ];
  const spans: Array<[string, string, Descriptor]> = [
    ...llm.map((d) => [d.emitName || "llm", "llm", d] as [string, string, Descriptor]),
    ...tools.map((d) => [d.emitName || d.id, "tool", d] as [string, string, Descriptor]),
  ];
  for (let i = 0; i < spans.length; i++) {
    const name = spans[i]![0];
    const branch = i === spans.length - 1 ? "└──" : "├──";
    lines.push(`${branch} ${name}`);
  }
  lines.push("```", "", "## Span emission points", "");
  lines.push("| Span | Kind | Source boundary | Mechanism |");
  lines.push("|---|---|---|---|");
  for (const d of [...llm, ...tools]) {
    const name = d.emitName || (d.kind === BoundaryKind.LLM ? "llm" : d.id);
    lines.push(`| ${name} | ${d.kind} | \`${d.matchCall}\` | ${_mechanism(d.kind, d.provider)} |`);
  }

  lines.push(
    "",
    "## Backend",
    "",
    `Spans are emitted and verified via the **${backend}** adapter. The one-time ` +
      "initialisation (tracer provider + exporter, and any provider instrumentors) is wired " +
      "at the telemetry-init site.",
    "",
    "## Keeping coverage from regressing",
    "",
    "- The boundary set is committed as `gigaphone.boundaries.yaml`, so routine and CI runs " +
      "are deterministic (no model re-deciding boundaries per run).",
    "- The post-edit hook flags any newly-added untraced tool or gateway.",
    "- Re-run `verify` to confirm the trace tree stays coherent end-to-end.",
    "",
  );
  return lines.join("\n") + "\n";
}

export interface WriteDocsOpts {
  harness: string;
  language: string;
  backend: string;
  descriptors: Descriptor[];
  plan: Plan;
  fixResult: FixResult;
  tree: TreeVerifyResult;
  traceLink?: string | null;
}

/** Write report.md + architecture.md under `docs/gigaphone/` and return their paths. */
export function writeDocs(repo: string, opts: WriteDocsOpts): string[] {
  const { harness, language, backend, descriptors, plan, fixResult, tree, traceLink = null } = opts;
  const outDir = join(repo, "docs", "gigaphone");
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, "report.md");
  const archPath = join(outDir, "architecture.md");
  writeFileSync(
    reportPath,
    renderReportMd({ harness, language, backend, plan, fixResult, tree, traceLink }),
    "utf-8",
  );
  writeFileSync(
    archPath,
    renderArchitectureMd({ harness, language, backend, descriptors, plan, tree }),
    "utf-8",
  );
  return [reportPath, archPath];
}
