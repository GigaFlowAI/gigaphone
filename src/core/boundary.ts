/**
 * Boundary vocabulary — invariant on all four axes (DESIGN §10, ADR-0003).
 *
 * These are the shared language between the classifier, the language packs (which detect the
 * modes), and the backend adapters (which carry the fix primitive). They name no harness,
 * language, vendor, or codebase. Modeled as `as const` objects so a member IS its wire
 * string (e.g. `BoundaryKind.LLM === "llm"`) — matching the Python str-enum semantics.
 */

export const BoundaryKind = {
  /** the gateway call that talks to the model */
  LLM: "llm",
  /** the function wrapping execution (trace the wrapper, not the sandbox) */
  TOOL_EXEC: "tool_exec",
  /** where the result is written back into the message list */
  TOOL_RESULT_SINK: "tool_result_sink",
  /** a call that dispatches a whole sub-agent (black box by ownership) */
  AGENT_CALL: "agent_call",
} as const;
export type BoundaryKind = (typeof BoundaryKind)[keyof typeof BoundaryKind];

/**
 * Why a tool result fails to land nested + complete. Only the fix primitive differs across
 * axes; the mode itself is invariant (DESIGN §10).
 */
export const FailureMode = {
  /** no single consumption layer; exec inlined/scattered */
  NO_BOUNDARY: "no_boundary",
  /** boundary exists, no span */
  UNTRACED: "untraced",
  /** traced but off the agent's context → orphan root trace */
  OFF_CONTEXT: "off_context",
  /** traced but logs only the truncated model-facing string */
  LOSSY_OUTPUT: "lossy_output",
} as const;
export type FailureMode = (typeof FailureMode)[keyof typeof FailureMode];

/**
 * The OpenInference LLM convention: what an `llm` span must carry to count as complete
 * (DESIGN §10). Neutral across vendor — the OTel/OpenInference adapter verifies these keys;
 * native adapters map onto their own equivalents. `llm.tool_calls` is emitted when the model
 * requested tools but is NOT required (absent on a final answer).
 */
export const LLM_CONVENTION_ATTRS = [
  "llm.model_name",
  "llm.input_messages",
  "llm.output_messages",
  "llm.token_count.prompt",
  "llm.token_count.completion",
] as const;

/** How a boundary was found (plan-record provenance, DESIGN §11). */
export const Source = {
  /** built-in anchor catalog */
  ANCHOR: "anchor",
  /** framework-level detection */
  FRAMEWORK: "framework",
  /** the committed boundary config */
  SPEC: "spec",
  /** resolved via the resolution protocol */
  AGENT: "agent",
} as const;
export type Source = (typeof Source)[keyof typeof Source];
