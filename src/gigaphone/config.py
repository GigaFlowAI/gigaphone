"""Boundary-config I/O + drift detection (DESIGN §8, ADR-0004).

The committed ``gigaphone.boundaries.yaml`` is the source of truth for routine runs; the
LLM is in the loop only for discovery and change. Drift = a committed anchor no longer
resolves to any boundary in the code.
"""

from __future__ import annotations

import os

from gigaphone import _yaml
from gigaphone.core.model import Descriptor

CONFIG_NAME = "gigaphone.boundaries.yaml"


def config_path(repo: str) -> str:
    return os.path.join(repo, CONFIG_NAME)


def load(repo: str) -> list[Descriptor]:
    path = config_path(repo)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        data = _yaml.load(fh.read())
    return [Descriptor.from_yaml_obj(o) for o in data.get("boundaries", [])]


def save(repo: str, descriptors: list[Descriptor]) -> str:
    path = config_path(repo)
    doc = {"boundaries": [d.to_yaml_obj() for d in descriptors]}
    header = (
        "# GigaPhone boundary config (DESIGN §8.4) — the fourth axis as data, not code.\n"
        "# Produced by discovery; consumed deterministically by routine/CI runs.\n"
        "# Leaf mappings use flow style `{ key: value }` (parsed dependency-free).\n"
    )
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(header)
        fh.write(_yaml.dump(doc))
    return path


def detect_drift(descriptors: list[Descriptor], resolved_match_calls: set[str]) -> list[str]:
    """Committed anchors that no longer resolve anywhere in the code (DESIGN §8.5)."""
    return [d.match_call for d in descriptors if d.match_call not in resolved_match_calls]
