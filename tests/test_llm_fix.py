"""LLM fix emission + expectation (OTel backend × Python pack).

A lossy LLM gateway (span present, convention missing) is fixed by inserting
`gigaphone_llm_complete(...)`; an untraced gateway is wrapped with `gigaphone_llm_trace`.
The verify expectation requires the OpenInference convention attrs on the span.
"""

from __future__ import annotations

from gigaphone.adapters.backend.otel import OtelAdapter
from gigaphone.core.boundary import LLM_CONVENTION_ATTRS, FailureMode
from gigaphone.packs.python.pack import PythonPack

_HAND_ROLLED = """\
from app.tracing import tracer

class LLMGateway:
    model = "acme-1"
    def chat(self, messages):
        with tracer().start_as_current_span("llm") as span:
            span.set_attribute("llm.model", self.model)
            reply = self._next(messages)
            return reply
"""

_UNTRACED = """\
class ModelClient:
    model = "acme-1"
    def generate(self, messages):
        return {"content": "hi"}
"""


def _boundary(src, func):
    pack = PythonPack()
    descs = pack.discover("app/g.py", src)
    return {b.func_name: b for b in pack.analyze("app/g.py", src, descs)}[func]


def test_lossy_llm_fix_inserts_llm_complete_call():
    pack, backend = PythonPack(), OtelAdapter()
    b = _boundary(_HAND_ROLLED, "chat")
    prim = backend.primitive_for(b, FailureMode.LOSSY_OUTPUT)
    edit = pack.emit_fix(b, prim, _HAND_ROLLED)
    text = "".join(h.new_text for h in edit.hunks)
    assert "gigaphone_llm_complete" in text
    assert "messages=messages" in text
    assert "response=reply" in text
    assert "model=self.model" in text
    # it must NOT fall back to the tool-output shim
    assert "gigaphone.output" not in text


def test_untraced_llm_fix_wraps_with_llm_trace_decorator():
    pack, backend = PythonPack(), OtelAdapter()
    b = _boundary(_UNTRACED, "generate")
    prim = backend.primitive_for(b, FailureMode.UNTRACED)
    edit = pack.emit_fix(b, prim, _UNTRACED)
    text = "".join(h.new_text for h in edit.hunks)
    assert "gigaphone_llm_trace" in text
    assert "messages_arg='messages'" in text


def test_llm_expectation_requires_the_convention():
    backend = OtelAdapter()
    b = _boundary(_HAND_ROLLED, "chat")
    exp = backend.expectation_for(b)
    assert exp.kind == "llm"
    for attr in LLM_CONVENTION_ATTRS:
        assert attr in exp.require_attrs, f"{attr} must be required on an llm span"
