"""`gigaphone verify` — run a representative path and confirm tool spans land nested +
complete via the backend adapter's read path (DESIGN §12, ADR-0005)."""

from __future__ import annotations

from gigaphone.core.model import Expectation, TreeVerifyResult, VerifyResult


def verify(
    root: str,
    expectations: list[Expectation],
    backend,
    module: str = "app.run_representative",
) -> list[VerifyResult]:
    if not expectations:
        return []
    project_ctx = {"repo": root, "root": root, "module": module}
    return backend.verify(project_ctx, expectations)


def verify_tree(
    root: str,
    expectations: list[Expectation],
    backend,
    module: str = "app.run_representative",
) -> TreeVerifyResult:
    """End-to-end: prove one representative run yields a single coherent trace tree with
    every LLM + tool span nested + complete and each requested tool linked (this feature)."""
    if not expectations:
        return TreeVerifyResult(single_root=False, root_span_name=None, detail="no expectations")
    project_ctx = {"repo": root, "root": root, "module": module}
    return backend.verify_tree(project_ctx, expectations)
