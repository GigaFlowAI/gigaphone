"""Representative path: a root `agent` span that dispatches the sub-agent once."""
from __future__ import annotations

from harness.service import run_subagent
from harness.tracing import init_tracing, tracer


def main() -> str:
    init_tracing()
    with tracer().start_as_current_span("agent") as span:
        span.set_attribute("agent.task", "delegate")
        result = run_subagent("summarize the repo")
        span.set_attribute("agent.final", result.final_output)
        return result.final_output


if __name__ == "__main__":
    main()
