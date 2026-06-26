"""Onboarding report (DESIGN §12) — the user-facing acceptance artifact.

Two surfaces: the one-line ``render`` summary, and the committed markdown artifacts
``report.md`` (problems + changes + verification) and ``architecture.md`` (the integrated
telemetry architecture). The markdown is deterministic — built from the plan, the applied
fixes, and the verified tree, with no model call (this feature)."""

from __future__ import annotations

import os

from gigaphone.core.boundary import BoundaryKind, FailureMode
from gigaphone.core.model import Descriptor, TreeVerifyResult, VerifyResult
from gigaphone.engine.fix import FixResult
from gigaphone.engine.plan import Plan

# why each failure mode loses telemetry — the rationale shown in report.md.
_WHY = {
    FailureMode.UNTRACED: "the boundary has no span, so its output never reaches the trace",
    FailureMode.OFF_CONTEXT: "the span is created off the agent's context, so it lands in a "
    "detached/orphan trace the eval platform can't see",
    FailureMode.LOSSY_OUTPUT: "the span records only a partial/truncated payload, losing the "
    "complete result (for an llm span: the OpenInference convention)",
    FailureMode.NO_BOUNDARY: "execution is inlined/scattered with no single consumption layer "
    "to trace",
}


def render(
    *,
    harness: str,
    language: str,
    backend: str,
    plan: Plan,
    verify_results: list[VerifyResult],
    trace_link: str | None = None,
) -> str:
    tools = [r for r in plan.records if r.kind.value == "tool_exec"]
    counts = {m: 0 for m in FailureMode}
    for r in plan.records:
        for m in r.failure_modes:
            counts[m] += 1
    verified = sum(1 for v in verify_results if v.ok)
    parts = [
        f"Harness: {harness} · Language: {language} · Backend: {backend}",
        f"{len(tools)} tools · "
        f"{counts[FailureMode.UNTRACED]} untraced · "
        f"{counts[FailureMode.OFF_CONTEXT]} off-context · "
        f"{counts[FailureMode.LOSSY_OUTPUT]} lossy"
        + (
            f" · {counts[FailureMode.NO_BOUNDARY]} no-boundary"
            if counts[FailureMode.NO_BOUNDARY]
            else ""
        ),
        f"Fixed + verified {verified}/{len(verify_results)} spans (nested + complete).",
    ]
    for v in verify_results:
        mark = "✓" if v.ok else "✗"
        parts.append(f"  {mark} {v.tool}: {'nested + complete' if v.ok else v.detail}")
    if plan.unresolved:
        parts.append(f"Unresolved (resolution protocol): {len(plan.unresolved)}")
    if trace_link:
        parts.append(f"Verified trace: {trace_link}")
    return "\n".join(parts)


def _mechanism(kind: BoundaryKind, provider: str | None) -> str:
    if kind == BoundaryKind.LLM:
        if provider and provider != "hand_rolled":
            return f"{provider} OpenInference instrumentor (Path 1)"
        return "gigaphone llm span — OpenInference convention (Path 2, hand-rolled)"
    return "gigaphone tool span (complete output recorded)"


def render_report_md(
    *,
    harness: str,
    language: str,
    backend: str,
    plan: Plan,
    fix_result: FixResult,
    tree: TreeVerifyResult,
    trace_link: str | None = None,
) -> str:
    lines: list[str] = [
        "# GigaPhone — Trace Coverage Report",
        "",
        f"**Harness:** {harness} · **Language:** {language} · **Backend:** {backend}",
        "",
        "## Problems found",
        "",
    ]
    problems = [r for r in plan.records if r.failure_modes]
    if problems:
        lines.append("| Boundary | Kind | Failure mode | Why it loses telemetry |")
        lines.append("|---|---|---|---|")
        for r in problems:
            modes = ", ".join(m.value for m in r.failure_modes)
            why = "; ".join(_WHY.get(m, "") for m in r.failure_modes)
            lines.append(f"| `{r.boundary}` | {r.kind.value} | {modes} | {why} |")
    else:
        lines.append("_No coverage gaps detected._")
    if plan.unresolved:
        lines.append("")
        lines.append(
            f"> {len(plan.unresolved)} boundary(ies) could not be localized automatically and "
            "were surfaced via the resolution protocol (never silently skipped)."
        )

    lines += ["", "## Changes applied", ""]
    if fix_result.edits:
        for edit in fix_result.edits:
            lines.append(f"- **`{edit.path}`** — {edit.description}")
        if fix_result.skipped_idempotent:
            lines.append(
                f"- _(skipped {fix_result.skipped_idempotent} already-applied edit(s) — fixes "
                "are idempotent)_"
            )
    else:
        lines.append("_No edits required._")

    lines += ["", "## Verification", ""]
    lines.append(
        f"- **Single root:** {'yes ✓' if tree.single_root else 'no ✗'} (`{tree.root_span_name}`)"
    )
    lines.append("")
    lines.append("| Span | Kind | Found | Nested | Complete |")
    lines.append("|---|---|---|---|---|")
    for r in tree.results:
        mark = lambda b: "✓" if b else "✗"  # noqa: E731
        detail = f" — {r.detail}" if r.detail else ""
        lines.append(
            f"| {r.tool} | {r.kind} | {mark(r.found)} | {mark(r.nested)} | "
            f"{mark(r.complete)}{detail} |"
        )
    if tree.linkage:
        lines += ["", "**Causal linkage (model tool request → tool span):**", ""]
        for link in tree.linkage:
            lines.append(f"- `{link.requested}` → {'linked ✓' if link.linked else 'NOT linked ✗'}")
    lines += ["", f"**Result:** {'all telemetry verified ✓' if tree.ok else 'gaps remain ✗'}"]
    if trace_link:
        lines.append(f"\nVerified trace: {trace_link}")
    return "\n".join(lines) + "\n"


def render_architecture_md(
    *,
    harness: str,
    language: str,
    backend: str,
    descriptors: list[Descriptor],
    plan: Plan,
    tree: TreeVerifyResult,
) -> str:
    llm = [d for d in descriptors if d.kind == BoundaryKind.LLM]
    tools = [d for d in descriptors if d.kind == BoundaryKind.TOOL_EXEC]
    root = tree.root_span_name or "agent"

    lines: list[str] = [
        "# Telemetry Architecture",
        "",
        "The instrumentation GigaPhone integrated into this codebase. Generated from the "
        "committed boundary config and the verified trace — regenerate after any change.",
        "",
        f"**Harness:** {harness} · **Language:** {language} · **Backend:** {backend}",
        "",
        "## Trace tree",
        "",
        "Every LLM call and tool execution is a span nested under the agent root:",
        "",
        "```",
        root,
    ]
    spans = [(d.emit_name or "llm", "llm", d) for d in llm] + [
        (d.emit_name or d.id, "tool", d) for d in tools
    ]
    for i, (name, _kind, _d) in enumerate(spans):
        branch = "└──" if i == len(spans) - 1 else "├──"
        lines.append(f"{branch} {name}")
    lines += ["```", "", "## Span emission points", ""]
    lines.append("| Span | Kind | Source boundary | Mechanism |")
    lines.append("|---|---|---|---|")
    for d in llm + tools:
        name = d.emit_name or ("llm" if d.kind == BoundaryKind.LLM else d.id)
        lines.append(
            f"| {name} | {d.kind.value} | `{d.match_call}` | {_mechanism(d.kind, d.provider)} |"
        )

    lines += [
        "",
        "## Backend",
        "",
        f"Spans are emitted and verified via the **{backend}** adapter. The one-time "
        "initialisation (tracer provider + exporter, and any provider instrumentors) is wired "
        "at the telemetry-init site.",
        "",
        "## Keeping coverage from regressing",
        "",
        "- The boundary set is committed as `gigaphone.boundaries.yaml`, so routine and CI runs "
        "are deterministic (no model re-deciding boundaries per run).",
        "- The post-edit hook flags any newly-added untraced tool or gateway.",
        "- Re-run `verify` to confirm the trace tree stays coherent end-to-end.",
        "",
    ]
    return "\n".join(lines) + "\n"


def write_docs(
    repo: str,
    *,
    harness: str,
    language: str,
    backend: str,
    descriptors: list[Descriptor],
    plan: Plan,
    fix_result: FixResult,
    tree: TreeVerifyResult,
    trace_link: str | None = None,
) -> list[str]:
    """Write report.md + architecture.md under ``docs/gigaphone/`` and return their paths."""
    out_dir = os.path.join(repo, "docs", "gigaphone")
    os.makedirs(out_dir, exist_ok=True)
    report_path = os.path.join(out_dir, "report.md")
    arch_path = os.path.join(out_dir, "architecture.md")
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write(
            render_report_md(
                harness=harness,
                language=language,
                backend=backend,
                plan=plan,
                fix_result=fix_result,
                tree=tree,
                trace_link=trace_link,
            )
        )
    with open(arch_path, "w", encoding="utf-8") as fh:
        fh.write(
            render_architecture_md(
                harness=harness,
                language=language,
                backend=backend,
                descriptors=descriptors,
                plan=plan,
                tree=tree,
            )
        )
    return [report_path, arch_path]
