"""BackendAdapter interface — the *vendor* axis (DESIGN §9, ADR-0002).

The entire vendor-specific surface: emit + verify. Two-tier — a generic OTel/OpenInference
adapter targets any OTLP backend (new platform = endpoint + headers, no code); native
adapters (Braintrust, LangSmith) override where native semantics win. Adapters cluster
into contextvars-native and OTel families and reuse most fix logic within a family.

Ships ``otel`` + ``braintrust`` + ``langsmith`` (contextvars-native family) +
``logfire`` + ``phoenix`` (OTel-native family) under ``adapters/backend/``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BackendAdapter(ABC):
    """One concrete subclass per observability vendor (or the generic OTel tier)."""

    id: str  # "otel" | "braintrust" | "langsmith" | ...

    @abstractmethod
    def detect_presence(self, repo: Any) -> bool:
        """Is this backend's SDK/OTel usage already present in the repo? Drives selection:
        OTel present → OTel adapter; native SDK present → that adapter; else customer choice."""

    @abstractmethod
    def config_schema(self) -> Any:
        """Schema for this backend's configuration (endpoint/headers/keys/project)."""

    @abstractmethod
    def init_snippet(self, config: Any) -> str:
        """The one-time initialisation snippet to add to the customer's codebase."""

    # --- fix primitives: one per fixable failure mode (DESIGN §10) ---

    @abstractmethod
    def trace_boundary(self, node: Any, kind: str) -> Any:
        """`untraced` fix: wrap the boundary in a span, type = tool."""

    @abstractmethod
    def restore_context(self) -> Any:
        """`off_context` fix: capture the parent and restore it across the pool/executor/queue."""

    @abstractmethod
    def map_output(self, output_spec: Any) -> Any:
        """`lossy_output` fix: log the complete-result fields, not just the model-facing string."""

    @abstractmethod
    def enable_framework(self, framework: str) -> Any:
        """Turn on framework-level instrumentation where the backend supports it."""

    @abstractmethod
    def verify(self, project: Any, run: Any) -> Any:
        """Confirm expected tool spans appear nested + complete in the customer's project,
        using the same read path the eval platform uses. No coverage without this (ADR-0005)."""
