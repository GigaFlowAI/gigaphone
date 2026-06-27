"""Backend-adapter registry + selection (DESIGN §9).

Selection: OTel already present → OTel adapter; native SDK present → that adapter; else the
customer's chosen platform. v1 ships the generic OTel default (native adapters land in M6).
"""

from __future__ import annotations

from gigaphone.adapters.backend.braintrust import BraintrustAdapter
from gigaphone.adapters.backend.langsmith import LangSmithAdapter
from gigaphone.adapters.backend.logfire import LogfireAdapter
from gigaphone.adapters.backend.otel import OtelAdapter
from gigaphone.adapters.backend.phoenix import PhoenixAdapter
from gigaphone.interfaces.backend_adapter import BackendAdapter

_BACKENDS: dict[str, BackendAdapter] = {
    "otel": OtelAdapter(),
    "braintrust": BraintrustAdapter(),
    "langsmith": LangSmithAdapter(),
    "logfire": LogfireAdapter(),
    "phoenix": PhoenixAdapter(),
}


def backend_by_id(backend_id: str) -> BackendAdapter | None:
    return _BACKENDS.get(backend_id)


def select_backend(repo: str, preferred: str | None = None) -> BackendAdapter:
    if preferred and preferred in _BACKENDS:
        return _BACKENDS[preferred]
    # Native SDK present → that adapter; else the generic OTel tier (DESIGN §9).
    for native in ("braintrust", "langsmith", "logfire", "phoenix"):
        if _BACKENDS[native].detect_presence(repo):
            return _BACKENDS[native]
    return _BACKENDS["otel"]
