"""`gigaphone review` — the bidirectional harness review (DESIGN §5; ADR-0004, ADR-0006).

Deterministic discovery is high-precision but misses indirect shapes; the harness audits
the proposal — REJECT false positives, ADD missed boundaries — and the result is committed.
The model is in the loop only here, at authoring time; CI replays the committed config.
"""

from __future__ import annotations

from gigaphone.core.boundary import BoundaryKind
from gigaphone.core.model import Descriptor


def apply_review(descriptors: list[Descriptor], review: dict) -> tuple[list[Descriptor], dict]:
    rejected = set(review.get("reject", []))
    kept = [d for d in descriptors if d.id not in rejected]
    added: list[Descriptor] = []
    for a in review.get("add", []):
        call = a["match_call"]
        added.append(
            Descriptor(
                id=a.get("id") or call,
                kind=BoundaryKind(a.get("kind", BoundaryKind.AGENT_CALL.value)),
                match_call=call,
                input_arg=a.get("input_arg"),
                output_paths=list(a.get("output_paths", [])),
                emit_name=a.get("emit_name"),
            )
        )
    by_call: dict = {d.match_call: d for d in kept}
    for d in added:
        by_call[d.match_call] = d
    summary = {
        "rejected": sorted(rejected),
        "added": [d.match_call for d in added],
        "kept": len(kept),
    }
    return list(by_call.values()), summary
