"""Stand-in for the openai-agents SDK — the black box. GigaPhone instruments NOTHING here."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Result:
    final_output: str
    events: list = field(default_factory=list)


class Runner:
    @staticmethod
    def run(task: str) -> "Result":
        return Result(final_output=f"done: {task}", events=["plan", "act"])
