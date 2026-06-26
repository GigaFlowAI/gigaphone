"""Customer observability wiring — honours $GIGAPHONE_SPAN_FILE, one JSON line per span."""
from __future__ import annotations

import json
import os

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExporter, SpanExportResult

_INITIALIZED = False


class _JsonlFileExporter(SpanExporter):
    def __init__(self, path: str) -> None:
        self._path = path

    def export(self, spans) -> SpanExportResult:
        with open(self._path, "a", encoding="utf-8") as fh:
            for s in spans:
                ctx = s.get_span_context()
                fh.write(
                    json.dumps(
                        {
                            "name": s.name,
                            "trace_id": format(ctx.trace_id, "032x"),
                            "span_id": format(ctx.span_id, "016x"),
                            "parent_id": (format(s.parent.span_id, "016x") if s.parent else None),
                            "attributes": {k: v for k, v in (s.attributes or {}).items()},
                        }
                    )
                    + "\n"
                )
        return SpanExportResult.SUCCESS


def init_tracing() -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    provider = TracerProvider()
    span_file = os.environ.get("GIGAPHONE_SPAN_FILE")
    if span_file:
        provider.add_span_processor(SimpleSpanProcessor(_JsonlFileExporter(span_file)))
    trace.set_tracer_provider(provider)
    _INITIALIZED = True


def tracer():
    init_tracing()
    return trace.get_tracer("harness")
