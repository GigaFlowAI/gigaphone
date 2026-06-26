"""The agent loop — dispatches tool calls from the gateway through a tool registry.

The registry (a module-level dict mapping tool name -> callable) is a built-in dispatch
anchor (DESIGN §7.1) that GigaPhone discovery enumerates to find the tool boundaries.
"""

from __future__ import annotations

from app.exec_tool import run_code
from app.gateway import LLMGateway, Message
from app.tracing import tracer
from app.web_tools import fetch_url, web_search

# Tool dispatch registry — discovery reads this to enumerate the agent's tools.
TOOLS = {
    "run_code": run_code,
    "web_search": web_search,
    "fetch_url": fetch_url,
}


def _to_model_content(result) -> str:
    """Build the (necessarily truncated) model-facing tool message. The complete result
    belongs in the trace, not here — that is GigaPhone's job, not the model's."""
    text = str(result)
    return text[:120]


def run_agent(task: str) -> str:
    gateway = LLMGateway()
    with tracer().start_as_current_span("agent") as span:
        span.set_attribute("agent.task", task)
        messages = [Message("system", "You are a helpful agent."), Message("user", task)]
        for _ in range(8):  # bounded loop
            reply = gateway.chat(messages)
            messages.append(reply)
            if reply.tool_call is None:
                span.set_attribute("agent.final", reply.content)
                return reply.content
            tool = TOOLS[reply.tool_call.name]
            result = tool(**reply.tool_call.arguments)  # consumption boundary call site
            messages.append(
                Message(
                    "tool",
                    content=_to_model_content(result),
                    tool_call_id=reply.tool_call.name,
                )
            )
        return "stopped: reached step limit"
