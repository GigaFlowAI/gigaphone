"""Boundary vocabulary — invariant on all four axes (DESIGN §10, ADR-0003).

These enums are the shared language between the classifier, the language packs (which
detect the modes), and the backend adapters (which carry the fix primitive). They name
no harness, language, vendor, or codebase.
"""

from __future__ import annotations

from enum import Enum


# str-mixin enum (not enum.StrEnum) so the engine runs on Python 3.9+ — the system
# `python3` on many machines (e.g. Apple's 3.9) — with zero dependencies. `.value` gives
# the wire string; members compare equal to their string value.
class _StrEnum(str, Enum):
    def __str__(self) -> str:  # match StrEnum: str(member) == member.value
        return self.value


class BoundaryKind(_StrEnum):
    """What a boundary *is* (DESIGN §8.4 ``kind``)."""

    LLM = "llm"  # the gateway call that talks to the model
    TOOL_EXEC = "tool_exec"  # the function wrapping execution (trace the wrapper, not the sandbox)
    TOOL_RESULT_SINK = "tool_result_sink"  # where the result is written back into the message list


class FailureMode(_StrEnum):
    """Why a tool result fails to land nested + complete. Only the fix primitive differs
    across axes; the mode itself is invariant (DESIGN §10)."""

    NO_BOUNDARY = "no_boundary"  # no single consumption layer; exec inlined/scattered
    UNTRACED = "untraced"  # boundary exists, no span
    OFF_CONTEXT = "off_context"  # traced but off the agent's context → orphan root trace
    LOSSY_OUTPUT = "lossy_output"  # traced but logs only the truncated model-facing string


# The OpenInference LLM convention: what an `llm` span must carry to count as complete
# (DESIGN §10, this feature). Neutral across vendor — the OTel/OpenInference adapter
# verifies these keys; native adapters map onto their own equivalents. `llm.tool_calls` is
# emitted when the model requested tools but is NOT required (absent on a final answer).
LLM_CONVENTION_ATTRS = (
    "llm.model_name",
    "llm.input_messages",
    "llm.output_messages",
    "llm.token_count.prompt",
    "llm.token_count.completion",
)


class Source(_StrEnum):
    """How a boundary was found (plan-record provenance, DESIGN §11)."""

    ANCHOR = "anchor"  # built-in anchor catalog
    FRAMEWORK = "framework"  # framework-level detection
    SPEC = "spec"  # the committed boundary config
    AGENT = "agent"  # resolved via the resolution protocol
