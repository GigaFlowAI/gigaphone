"""`gigaphone fix` — route failure modes to backend primitives, render via the language
pack, apply byte-accurate idempotent edits, and emit reviewable diffs (DESIGN §11).
"""

from __future__ import annotations

import difflib
import os
from dataclasses import dataclass, field

from gigaphone.core.model import Boundary, CodeEdit, Expectation, Hunk
from gigaphone.engine import project
from gigaphone.packs.registry import pack_for_path


@dataclass
class FixResult:
    edits: list[CodeEdit] = field(default_factory=list)
    expectations: list[Expectation] = field(default_factory=list)
    diffs: dict[str, str] = field(default_factory=dict)  # rel_path -> unified diff
    skipped_idempotent: int = 0


def plan_fixes(root: str, boundaries: list[Boundary], backend) -> FixResult:
    """Compute the edits + expectations without writing (for diff preview)."""
    result = FixResult()
    # group edits per file so multiple boundaries in one file compose
    per_file: dict[str, list[CodeEdit]] = {}
    for b in boundaries:
        if not b.failure_modes:
            continue
        pack = pack_for_path(os.path.join(root, b.path))
        if pack is None:
            continue
        source = project.read(project.SourceFile(b.path, os.path.join(root, b.path)))
        for mode in b.failure_modes:
            primitive = backend.primitive_for(b, mode, pack.id)
            edit = pack.emit_fix(b, primitive, source)
            if edit is not None:
                per_file.setdefault(b.path, []).append(edit)
        result.expectations.append(backend.expectation_for(b))

    for edits in per_file.values():
        result.edits.extend(edits)
    return result


def apply_fixes(root: str, boundaries: list[Boundary], backend) -> FixResult:
    """Apply fixes idempotently and produce unified diffs."""
    result = plan_fixes(root, boundaries, backend)
    per_file: dict[str, list[CodeEdit]] = {}
    for edit in result.edits:
        per_file.setdefault(edit.path, []).append(edit)

    for rel_path, edits in per_file.items():
        abs_path = os.path.join(root, rel_path)
        with open(abs_path, encoding="utf-8") as fh:
            before = fh.read()
        after, skipped = _apply_hunks(before, edits)
        result.skipped_idempotent += skipped
        if after != before:
            with open(abs_path, "w", encoding="utf-8") as fh:
                fh.write(after)
            result.diffs[rel_path] = "".join(
                difflib.unified_diff(
                    before.splitlines(keepends=True),
                    after.splitlines(keepends=True),
                    fromfile=f"a/{rel_path}",
                    tofile=f"b/{rel_path}",
                )
            )
    return result


def _apply_hunks(source: str, edits: list[CodeEdit]) -> tuple[str, int]:
    """Apply all hunks for one file. Idempotent: a hunk whose tag already occurs in the
    file is skipped (no double-wrapping). Hunks apply on byte offsets, descending, so
    earlier offsets stay valid (golden principle 7)."""
    data = source.encode("utf-8")
    hunks: list[Hunk] = []
    skipped = 0
    seen_tags: set[str] = set()
    for edit in edits:
        for h in edit.hunks:
            if h.tag in source or h.tag in seen_tags:
                skipped += 1
                continue
            seen_tags.add(h.tag)
            hunks.append(h)
    # de-dupe identical import hunks at the same offset
    for h in sorted(hunks, key=lambda x: x.byte_start, reverse=True):
        data = data[: h.byte_start] + h.new_text.encode("utf-8") + data[h.byte_end :]
    return data.decode("utf-8"), skipped
