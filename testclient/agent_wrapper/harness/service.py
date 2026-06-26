"""The harness wraps a whole sub-agent. `run_subagent` is the agent_call boundary —
UNTRACED before GigaPhone."""
from __future__ import annotations

from agents import Runner


def run_subagent(task: str):
    result = Runner.run(task)
    return result
