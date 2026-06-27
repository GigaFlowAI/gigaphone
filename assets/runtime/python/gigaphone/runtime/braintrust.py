"""Braintrust runtime shim (contextvars-native family, DESIGN §9).

Identical call sites to ``gigaphone.runtime.otel`` — ``gigaphone_trace`` /
``gigaphone_propagate`` / ``gigaphone_complete`` — backed by Braintrust's native tracing
(``@traced`` / ``span_type="tool"``) when the ``braintrust`` SDK is importable. Braintrust
nests via contextvars, so it orphans across thread pools exactly like OTel; the propagate
primitive copies the contextvars context into pool workers.

Import-safe: ``braintrust`` is imported lazily. When it is absent the shim degrades to the
generic OTel primitives so fixed code still runs and stays verifiable in CI. (Exact
Braintrust APIs to be confirmed at implementation time — DESIGN §9.)
"""

from __future__ import annotations

import contextvars
import functools
from collections.abc import Iterable
from typing import Any

from gigaphone.runtime import otel as _otel


def _braintrust():
    try:
        import braintrust  # type: ignore[import-not-found]

        return braintrust
    except ImportError:
        return None


def _complete(value: Any, fields: Iterable[str]) -> dict:
    fields = list(fields)
    if not fields:
        return {"output": _otel._stringify(value)}
    return {f: _otel._stringify(_otel._resolve(value, f)) for f in fields}


def gigaphone_trace(name: str, kind: str = "tool", output: Iterable[str] = ()):
    """Decorator: trace a previously-untraced boundary as a Braintrust ``tool`` span with
    complete output. Falls back to the OTel shim when the SDK is absent."""
    bt = _braintrust()
    if bt is None:
        return _otel.gigaphone_trace(name, kind=kind, output=output)
    fields = tuple(output)

    def deco(fn):
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            with bt.start_span(name=name, type=kind) as span:
                span.log(input={"args": args, "kwargs": kwargs})
                result = fn(*args, **kwargs)
                span.log(output=_complete(result, fields))
                return result

        wrapper.__gigaphone_traced__ = True  # type: ignore[attr-defined]
        return wrapper

    return deco


def gigaphone_propagate(executor):
    """Wrap an executor so submitted callables run with the submitting thread's contextvars
    context copied in — re-parenting Braintrust worker spans under the agent (off_context)."""
    if getattr(executor, "__gigaphone_propagating__", False):
        return executor
    if _braintrust() is None:
        return _otel.gigaphone_propagate(executor)
    original_submit = executor.submit

    def submit(fn, /, *args, **kwargs):
        ctx = contextvars.copy_context()

        @functools.wraps(fn)
        def run():
            return ctx.run(fn, *args, **kwargs)

        return original_submit(run)

    executor.submit = submit  # type: ignore[method-assign]
    executor.__gigaphone_propagating__ = True  # type: ignore[attr-defined]
    return executor


def gigaphone_complete(span, value: Any, fields: Iterable[str] = ()) -> None:
    """Record complete output on an already-open span (lossy_output fix). Uses Braintrust's
    ``span.log`` when available, else the OTel attribute setter."""
    if _braintrust() is not None and hasattr(span, "log"):
        span.log(output=_complete(value, fields))
        return
    _otel.gigaphone_complete(span, value, fields)
