"""LanguagePack interface — the *language* axis (DESIGN §7, ADR-0002).

Carries everything language-specific so the engine, classifier, specs, plan records, and
both adapters stay language-neutral. A new language is a new pack (grammar + queries +
def-use + hop-signatures + emitters) with **no engine change**.

v1 ships ``python`` and ``typescript`` packs (under ``packs/``).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class LanguagePack(ABC):
    """One concrete subclass per language. Methods are placeholders pending M2/M6."""

    id: str  # "python" | "typescript" | ...

    @abstractmethod
    def grammar(self) -> Any:
        """The tree-sitter grammar for this language."""

    @abstractmethod
    def anchor_queries(self) -> Any:
        """S-expression queries realising the anchor catalog (DESIGN §7.1) in this language."""

    @abstractmethod
    def defuse_rules(self) -> Any:
        """Shallow same-file def-use: sink ← value ← producing fn. Contract is part of the
        pack spec so coverage doesn't vary by language (DESIGN §16)."""

    @abstractmethod
    def context_hop_signatures(self) -> Any:
        """``off_context`` signatures for this language's concurrency model
        (py contextvars/thread pools vs ts AsyncLocalStorage/worker_threads)."""

    @abstractmethod
    def codemod_emitters(self) -> Any:
        """How to insert/wrap each backend primitive in this syntax, via byte ranges so
        inserts don't reformat the file. Emissions must be idempotent."""

    @abstractmethod
    def compile_match(self, dotted_call: str) -> Any:
        """Compile a backend-/codebase-neutral ``match.call`` dotted name into a query in
        this language (DESIGN §8.4). Raw tree-sitter patterns are the escape hatch."""
