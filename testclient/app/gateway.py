"""Acme's hand-rolled LLM gateway — NO provider SDK.

This is the codebase-specific gateway GigaPhone must *discover* (it is invisible to the
built-in provider anchors, DESIGN §8). The customer already traces it as an "llm" span,
so LLM visibility is fine; what gets lost downstream is the *tool* output. The model is a
deterministic mock so the onboarding e2e is reproducible without a network call.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.tracing import tracer


@dataclass
class ToolCall:
    name: str
    arguments: dict


@dataclass
class Message:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str = ""
    tool_call: ToolCall | None = None
    tool_call_id: str | None = None
    usage: dict | None = None  # the gateway HAS token usage; it just isn't traced (lossy)


@dataclass
class LLMGateway:
    """Hand-rolled gateway. `chat` is the LLM consumption boundary (kind=llm)."""

    model: str = "acme-mock-1"
    _script: list = field(default_factory=list)

    def chat(self, messages: list[Message]) -> Message:
        # Traced: the customer has LLM visibility already.
        with tracer().start_as_current_span("llm") as span:
            span.set_attribute("llm.model", self.model)
            span.set_attribute("llm.n_messages", len(messages))
            reply = self._next(messages)
            # The gateway computes usage but only logs model + count — input/output messages
            # and token usage never reach the span. That is the lossy LLM boundary.
            reply.usage = {
                "prompt": sum(len(m.content) for m in messages),
                "completion": len(reply.content),
            }
            span.set_attribute("llm.tool_call", reply.tool_call.name if reply.tool_call else "")
            return reply

    @staticmethod
    def _next(messages: list[Message]) -> Message:
        # Deterministic plan: run_code -> web_search -> fetch_url -> final answer.
        n_tool_results = sum(1 for m in messages if m.role == "tool")
        if n_tool_results == 0:
            return Message(
                "assistant", tool_call=ToolCall("run_code", {"code": "print(sum(range(10)))"})
            )
        if n_tool_results == 1:
            return Message(
                "assistant", tool_call=ToolCall("web_search", {"query": "python sum builtin"})
            )
        if n_tool_results == 2:
            return Message(
                "assistant", tool_call=ToolCall("fetch_url", {"url": "https://example.com/doc"})
            )
        return Message("assistant", content="Done: computed the sum and gathered references.")
