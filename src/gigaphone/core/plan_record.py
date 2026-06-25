"""Plan record — the axis-neutral unit the fix engine consumes (DESIGN §11).

A plan record names no harness, no vendor, and no codebase specifics beyond what
discovery already wrote into config. It says only: *here is a boundary, here is what's
wrong with its span coverage, here is the complete output it should carry.* The codemod
engine routes off ``failure_modes`` to backend-adapter primitives rendered by the active
language pack.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from gigaphone.core.boundary import BoundaryKind, FailureMode, Source


@dataclass(frozen=True)
class PlanRecord:
    boundary: str  # "tools/exec.py:42"  (path:line)
    language: str  # "python" | "typescript" | ...
    provider_or_framework: str  # "anthropic" | "langgraph" | "acme-gateway" | ...
    kind: BoundaryKind
    tools_covered: list[str] = field(default_factory=list)
    failure_modes: list[FailureMode] = field(default_factory=list)
    complete_output_fields: list[str] = field(default_factory=list)
    source: Source = Source.ANCHOR

    def to_dict(self) -> dict:
        """JSON-ready dict; enums rendered as their string values (matches DESIGN §11)."""
        d = asdict(self)
        d["kind"] = self.kind.value
        d["failure_modes"] = [m.value for m in self.failure_modes]
        d["source"] = self.source.value
        return d

    @classmethod
    def from_dict(cls, d: dict) -> PlanRecord:
        return cls(
            boundary=d["boundary"],
            language=d["language"],
            provider_or_framework=d["provider_or_framework"],
            kind=BoundaryKind(d["kind"]),
            tools_covered=list(d.get("tools_covered", [])),
            failure_modes=[FailureMode(m) for m in d.get("failure_modes", [])],
            complete_output_fields=list(d.get("complete_output_fields", [])),
            source=Source(d.get("source", Source.ANCHOR.value)),
        )
