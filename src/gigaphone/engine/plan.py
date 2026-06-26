"""`gigaphone plan` — boundaries → plan records, plus the unresolved[] list (DESIGN §5, §11).

A descriptor that resolved to no boundary is *unresolved* (the ambiguous ~20% the
deterministic pass can't localize) and is surfaced via the resolution protocol — never
silently skipped (golden principle 8).
"""

from __future__ import annotations

from dataclasses import dataclass

from gigaphone.core.boundary import BoundaryKind
from gigaphone.core.model import Boundary, Descriptor
from gigaphone.core.plan_record import PlanRecord


@dataclass
class Unresolved:
    descriptor_id: str
    match_call: str
    question: str


@dataclass
class Plan:
    records: list[PlanRecord]
    unresolved: list[Unresolved]

    @property
    def fixable(self) -> list[PlanRecord]:
        return [r for r in self.records if r.failure_modes]


def build_plan(descriptors: list[Descriptor], boundaries: list[Boundary]) -> Plan:
    records = [
        PlanRecord(
            boundary=f"{b.path}:{b.range.line}",
            language="python",
            provider_or_framework=b.provider_or_framework,
            kind=b.kind,
            tools_covered=list(b.tools_covered),
            failure_modes=list(b.failure_modes),
            complete_output_fields=list(b.complete_output_fields),
            source=b.source,
        )
        for b in boundaries
    ]
    resolved_calls = {b.call for b in boundaries}
    unresolved = [
        Unresolved(d.id, d.match_call, _question_for(d))
        for d in descriptors
        if d.match_call not in resolved_calls and d.kind != BoundaryKind.LLM
    ]
    return Plan(records=records, unresolved=unresolved)


def _question_for(d: Descriptor) -> str:
    if d.kind == BoundaryKind.AGENT_CALL:
        return (
            f"Could not localize `{d.match_call}` (agent_call). Which function dispatches "
            "the sub-agent and returns its result? (The sub-agent itself is a black box — we "
            "trace only this boundary.)"
        )
    return (
        f"Could not localize `{d.match_call}` ({d.kind.value}). "
        "Which function consumes its result and returns it to the agent loop?"
    )
