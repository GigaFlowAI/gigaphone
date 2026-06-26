"""Onboarding report (DESIGN §12) — the user-facing acceptance artifact."""

from __future__ import annotations

from gigaphone.core.boundary import FailureMode
from gigaphone.core.model import VerifyResult
from gigaphone.engine.plan import Plan


def render(
    *,
    harness: str,
    language: str,
    backend: str,
    plan: Plan,
    verify_results: list[VerifyResult],
    trace_link: str | None = None,
) -> str:
    boundaries = [r for r in plan.records if r.kind.value in ("tool_exec", "agent_call")]
    counts = {m: 0 for m in FailureMode}
    for r in plan.records:
        for m in r.failure_modes:
            counts[m] += 1
    verified = sum(1 for v in verify_results if v.ok)
    parts = [
        f"Harness: {harness} · Language: {language} · Backend: {backend}",
        f"{len(boundaries)} boundaries · "
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
