"""Logfire runtime shim (OTel family, DESIGN §9).

Logfire is OTel-native: ``logfire.configure()`` installs a global OTel ``TracerProvider``,
so spans emitted through the standard OTel API already land in Logfire. The one place a
native API wins is span creation — ``logfire.span(name)`` records Logfire's structured
message/attributes — so ``gigaphone_trace`` prefers it when the SDK is importable and
degrades to the OTel shim otherwise. Context propagation uses the OTel context API
(Logfire nests through it), and the OpenInference ``llm.*`` convention rides the OTel span,
so ``gigaphone_propagate`` and the LLM primitives delegate to ``gigaphone.runtime.otel``.

Import-safe: ``logfire`` is imported lazily. When it is absent the shim is the generic OTel
shim, so fixed code still runs and stays verifiable in CI.
"""

from __future__ import annotations

import functools
from collections.abc import Iterable
from typing import Any

from gigaphone.runtime import otel as _otel
from gigaphone.runtime.otel import (  # OTel-context-native: reuse unchanged
    gigaphone_llm_complete,
    gigaphone_llm_trace,
    gigaphone_propagate,
)

__all__ = [
    "gigaphone_complete",
    "gigaphone_llm_complete",
    "gigaphone_llm_trace",
    "gigaphone_propagate",
    "gigaphone_trace",
]


def _logfire():
    try:
        import logfire  # type: ignore[import-not-found]

        return logfire
    except ImportError:
        return None


def gigaphone_trace(name: str, kind: str = "tool", output: Iterable[str] = ()):
    """Decorator: trace a previously-untraced boundary as a Logfire span with complete
    output. Uses ``logfire.span`` when the SDK is present (so the span carries Logfire's
    structured attributes); falls back to the OTel shim otherwise. The span opens in the
    current context, so it nests under the agent either way."""
    lf = _logfire()
    if lf is None:
        return _otel.gigaphone_trace(name, kind=kind, output=output)
    fields = tuple(output)

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            with lf.span(name) as span:
                span.set_attribute("gigaphone.kind", kind)
                span.set_attribute(
                    "gigaphone.input", _otel._stringify({"args": args, "kwargs": kwargs})
                )
                result = fn(*args, **kwargs)
                _otel._record_output(span, result, fields)
                return result

        wrapper.__gigaphone_traced__ = True  # type: ignore[attr-defined]
        return wrapper

    return deco


def gigaphone_complete(span, value: Any, fields: Iterable[str] = ()) -> None:
    """Record complete output on an already-open span (lossy_output fix). Logfire spans are
    OTel spans, so the OTel attribute setter applies whether or not the SDK is installed."""
    _otel.gigaphone_complete(span, value, fields)
