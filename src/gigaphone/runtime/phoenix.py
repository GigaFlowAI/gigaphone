"""Arize/Phoenix runtime shim (OTel family, DESIGN §9).

Phoenix/Arize is OTel-native: ``phoenix.otel.register()`` (or ``arize.otel.register()``)
installs a global OTel ``TracerProvider`` and the OpenInference exporter, so gigaphone's
standard OTel-API spans — emitted by ``gigaphone.runtime.otel`` — land in the Phoenix/Arize
project unchanged. There is no vendor-divergent runtime surface to add: the call sites,
context propagation (OTel context API), and the OpenInference ``llm.*`` convention are
exactly the generic OTel shim's. This module re-exports them so emitted fixes can import
``from gigaphone.runtime.phoenix import …`` and read as a first-class native shim, matching
the Braintrust/LangSmith placement.
"""

from __future__ import annotations

from gigaphone.runtime.otel import (
    gigaphone_complete,
    gigaphone_llm_complete,
    gigaphone_llm_trace,
    gigaphone_propagate,
    gigaphone_trace,
)

__all__ = [
    "gigaphone_complete",
    "gigaphone_llm_complete",
    "gigaphone_llm_trace",
    "gigaphone_propagate",
    "gigaphone_trace",
]
