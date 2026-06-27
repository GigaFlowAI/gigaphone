/** GigaPhone TypeScript runtime shim — type declarations (see gigaphone-core.mjs). */

export interface GigaphoneTraceOptions {
  /** Span name (the boundary's emit name). */
  name?: string;
  /** Span kind: "tool" for tool executions, "agent" for sub-agent dispatches. */
  kind?: "tool" | "agent" | "llm";
  /** Dotted paths into the return value to record as `gigaphone.output.*`. */
  output?: string[];
}

/**
 * Curried, async-correct boundary tracer. `gigaphoneTrace(opts)(fn)` runs `fn` inside a span
 * nested under the current one and returns whatever `fn` returns (awaiting a promise before
 * the span ends). Generic over sync and async `fn`.
 */
export function gigaphoneTrace(
  opts?: GigaphoneTraceOptions,
): <T>(fn: () => T) => T;

/** OFF_CONTEXT fix: wrap an executor/pool so its callables keep the agent context. */
export function gigaphonePropagate<E>(executor: E): E;

/** LOSSY_OUTPUT fix: record complete output on an already-open span. */
export function gigaphoneComplete(
  span: unknown,
  value: unknown,
  fields?: string[],
): void;
