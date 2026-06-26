"""Runtime shim for LLM spans — records the OpenInference LLM convention.

The hand-rolled-gateway fix inserts `gigaphone_llm_complete(...)` into an existing span;
the untraced-gateway fix wraps the gateway with `gigaphone_llm_trace(...)`. Both must emit
input messages, output messages, model name, token usage, and any requested tool calls.
"""

from __future__ import annotations


class _FakeSpan:
    def __init__(self) -> None:
        self.attrs: dict = {}

    def set_attribute(self, key, value):
        self.attrs[key] = value


def test_llm_complete_records_the_openinference_convention():
    from gigaphone.runtime.otel import gigaphone_llm_complete

    span = _FakeSpan()
    messages = [{"role": "user", "content": "hi"}]
    response = {"role": "assistant", "content": "hello", "tool_calls": [{"name": "run_code"}]}
    usage = {"prompt": 11, "completion": 7}

    gigaphone_llm_complete(span, messages=messages, response=response, model="acme-1", usage=usage)

    assert span.attrs["llm.model_name"] == "acme-1"
    assert span.attrs["llm.token_count.prompt"] == 11
    assert span.attrs["llm.token_count.completion"] == 7
    assert "hi" in span.attrs["llm.input_messages"]
    assert "hello" in span.attrs["llm.output_messages"]
    assert "run_code" in span.attrs["llm.tool_calls"]


def test_llm_complete_tolerates_missing_usage():
    from gigaphone.runtime.otel import gigaphone_llm_complete

    span = _FakeSpan()
    gigaphone_llm_complete(
        span, messages=[{"role": "user", "content": "x"}], response="ok", model="m", usage=None
    )

    assert span.attrs["llm.model_name"] == "m"
    assert "llm.token_count.prompt" not in span.attrs  # no usage -> not fabricated
    assert "ok" in span.attrs["llm.output_messages"]


def test_llm_trace_decorator_opens_a_span_and_records_convention():
    from gigaphone.runtime.otel import gigaphone_llm_trace

    @gigaphone_llm_trace(name="acme.llm", model_attr="model", messages_arg="messages")
    def chat(self, messages):
        return {"content": "answer"}

    class _GW:
        model = "acme-2"

    # smoke: the decorator must be transparent (returns the wrapped value) and marked traced.
    out = chat(_GW(), messages=[{"role": "user", "content": "q"}])
    assert out == {"content": "answer"}
    assert getattr(chat, "__gigaphone_traced__", False) is True
