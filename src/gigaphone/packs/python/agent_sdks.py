"""Agent-SDK catalog — seed family B (DESIGN §8.4; spec 2026-06-26).

Finite, enumerable signatures for frameworks that dispatch a whole sub-agent. Data, not
heuristics: tools can be any function and so are never seeded, but agent SDKs are a closed
set. Contributors add entries here (or via the resolution protocol's contribution step).
The sub-agent itself is a black box by ownership — we recognize the *dispatch*, never its
internals.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AgentSdk:
    id: str
    framework: str
    calls: tuple[str, ...] = ()  # dotted-suffix call signatures, e.g. "Runner.run", ".invoke"
    constructs: tuple[str, ...] = ()  # constructed symbols that signal an agent, e.g. "Agent"
    carriers: tuple[str, ...] = ()  # outbound carriers paired with a construct, e.g. ".post"
    packages: tuple[str, ...] = ()  # package names for provenance lookups, e.g. "agents", "langgraph"
    input_arg: str | None = None
    output_fields: tuple[str, ...] = field(default_factory=tuple)


AGENT_SDKS: tuple[AgentSdk, ...] = (
    AgentSdk("langgraph", "langgraph", calls=(".invoke", ".ainvoke", ".stream"),
             packages=("langgraph",),
             input_arg="input", output_fields=("messages",)),
    AgentSdk("openai-agents", "openai-agents", calls=("Runner.run", "Runner.run_sync"),
             packages=("agents",),
             output_fields=("final_output",)),
    AgentSdk("crewai", "crewai", calls=(".kickoff", ".kickoff_async"),
             packages=("crewai",),
             output_fields=("raw", "tasks_output")),
    AgentSdk("llama-index", "llama-index", calls=(".achat", ".run"),
             packages=("llama_index",),
             output_fields=("response",)),
    AgentSdk("autogen", "autogen", calls=(".initiate_chat", ".run"),
             packages=("autogen", "autogen_agentchat"),
             output_fields=("summary", "chat_history")),
    # OpenHands: an Agent config is constructed and handed to an outbound HTTP carrier.
    AgentSdk("openhands-sdk", "openhands-sdk",
             constructs=("Agent", "StartConversationRequest"),
             packages=("openhands",),
             carriers=(".post",), output_fields=("events", "final_message")),
)


def match_call_site(dotted: str) -> AgentSdk | None:
    """Return the catalog entry whose `calls` signature matches this call's dotted name.

    A signature starting with "." matches on the trailing attribute (`graph.invoke` →
    ".invoke"); otherwise it must be a dotted suffix (`Runner.run`)."""
    for sdk in AGENT_SDKS:
        for sig in sdk.calls:
            if sig.startswith("."):
                if dotted.endswith(sig) and dotted != sig.lstrip("."):
                    return sdk
            elif dotted == sig or dotted.endswith("." + sig):
                return sdk
    return None


def methods(sdk: AgentSdk) -> set:
    """Return the set of trailing method names from an SDK's call signatures."""
    return {sig.rsplit(".", 1)[-1] for sig in sdk.calls}


def match_package_method(pkg: str, method: str) -> AgentSdk | None:
    """Return the catalog entry matching a package + method combination.

    Args:
        pkg: Package name for provenance.
        method: Trailing method name (e.g., "run", "invoke").

    Returns:
        The matching AgentSdk, or None if no match is found.
    """
    if not pkg:
        return None
    for sdk in AGENT_SDKS:
        if pkg in sdk.packages and method in methods(sdk):
            return sdk
    return None


def match_construct(symbol: str, pkg: str) -> AgentSdk | None:
    """Return the catalog entry matching a construct symbol + package combination.

    Args:
        symbol: Construct symbol name (e.g., "Agent", "StartConversationRequest").
        pkg: Package name for provenance.

    Returns:
        The matching AgentSdk, or None if no match is found.
    """
    if not pkg:
        return None
    for sdk in AGENT_SDKS:
        if symbol in sdk.constructs and pkg in sdk.packages:
            return sdk
    return None


def carrier_methods() -> set:
    """Return the set of trailing method names from all carriers in the catalog."""
    out: set = set()
    for sdk in AGENT_SDKS:
        out |= {c.rsplit(".", 1)[-1] for c in sdk.carriers}
    return out


def format_entry(
    id: str,
    framework: str,
    *,
    calls: tuple[str, ...] = (),
    constructs: tuple[str, ...] = (),
    carriers: tuple[str, ...] = (),
    packages: tuple[str, ...] = (),
    input_arg: str | None = None,
    output_fields: tuple[str, ...] = (),
) -> str:
    """Render a catalog-entry source block an OSS contributor (or the driving harness) can
    paste into AGENT_SDKS."""
    parts = [f'AgentSdk("{id}", "{framework}"']
    if calls:
        parts.append(f"calls={calls!r}")
    if constructs:
        parts.append(f"constructs={constructs!r}")
    if carriers:
        parts.append(f"carriers={carriers!r}")
    if packages:
        parts.append(f"packages={packages!r}")
    if input_arg:
        parts.append(f"input_arg={input_arg!r}")
    if output_fields:
        parts.append(f"output_fields={output_fields!r}")
    return ", ".join(parts) + "),"
