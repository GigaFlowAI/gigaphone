"""LLM boundary discovery + classification (Python pack).

The provider tag drives the fix path: a recognized SDK gets the provider's OpenInference
instrumentor enabled (Approach A, Path 1); a hand-rolled gateway gets a gigaphone LLM span
(Path 2). Classification reuses the failure-mode taxonomy with an LLM reading.
"""

from __future__ import annotations

from gigaphone.core.boundary import BoundaryKind, FailureMode
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

_SDK = """\
import openai

client = openai.OpenAI()

def call_model(messages):
    return client.chat.completions.create(model="gpt-4o", messages=messages)
"""

_UNTRACED_HAND_ROLLED = """\
class ModelClient:
    model = "acme-1"
    def generate(self, messages):
        return {"content": "hi"}
"""


def _disc(pack, path, src):
    return {d.match_call: d for d in pack.discover(path, src)}


def test_hand_rolled_gateway_tagged_hand_rolled():
    pack = PythonPack()
    d = _disc(pack, "app/gateway.py", _HAND_ROLLED)["app.gateway.LLMGateway.chat"]
    assert d.kind == BoundaryKind.LLM
    assert d.provider == "hand_rolled"


def test_openai_sdk_gateway_tagged_openai():
    pack = PythonPack()
    descs = _disc(pack, "app/llm.py", _SDK)
    d = descs["app.llm.call_model"]
    assert d.kind == BoundaryKind.LLM
    assert d.provider == "openai"


def test_lossy_llm_span_missing_convention_is_classified_lossy():
    pack = PythonPack()
    descs = pack.discover("app/gateway.py", _HAND_ROLLED)
    boundaries = {b.func_name: b for b in pack.analyze("app/gateway.py", _HAND_ROLLED, descs)}
    chat = boundaries["chat"]
    # a span exists but carries no OpenInference convention attrs -> lossy_output
    assert chat.failure_modes == [FailureMode.LOSSY_OUTPUT]


def test_untraced_hand_rolled_gateway_is_classified_untraced():
    pack = PythonPack()
    descs = pack.discover("app/client.py", _UNTRACED_HAND_ROLLED)
    boundaries = {
        b.func_name: b for b in pack.analyze("app/client.py", _UNTRACED_HAND_ROLLED, descs)
    }
    gen = boundaries["generate"]
    assert gen.failure_modes == [FailureMode.UNTRACED]
