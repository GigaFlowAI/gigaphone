/**
 * GigaPhone TypeScript runtime shim — the primitives that fixed code calls.
 *
 * Mirrors the Python shim (`gigaphone/runtime/otel.py`) one-for-one:
 *   - gigaphoneTrace     — UNTRACED: wrap a boundary in a span recording complete output.
 *   - gigaphonePropagate — OFF_CONTEXT: keep the agent context across a worker/pool.
 *   - gigaphoneComplete  — LOSSY_OUTPUT: add complete output to an existing span.
 *
 * Dependency-free: only Node built-ins (`node:async_hooks`, `node:crypto`, `node:fs`). It
 * nests spans via AsyncLocalStorage and, when `GIGAPHONE_SPAN_FILE` is set, appends each
 * finished span as one JSON line — the exact read path GigaPhone's backend adapter uses to
 * `verify` (the same shape the Python testclient exporter emits). With no span file and a
 * global tracer wired (`globalThis.__GIGAPHONE_SINK__`), it forwards there instead; failing
 * both it is a no-op, so fixed code always runs.
 *
 * The published `@gigaphone/otel` / `@gigaphone/braintrust` / `@gigaphone/langsmith`
 * packages are this core; only the customer's one-time init (the real OTLP/vendor exporter)
 * differs, and that lives at the telemetry-init site, not in these call sites.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

const als = new AsyncLocalStorage();

function hex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function stringify(value) {
  try {
    return JSON.stringify(value, (_k, v) => (v === undefined ? null : v));
  } catch {
    return String(value);
  }
}

function resolve(value, field) {
  let cur = value;
  for (const part of String(field).split(".")) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function recordOutput(span, value, fields) {
  if (fields && fields.length) {
    for (const f of fields) {
      span.attributes[`gigaphone.output.${f}`] = stringify(resolve(value, f));
    }
  } else {
    span.attributes["gigaphone.output"] = stringify(value);
  }
}

function emit(span) {
  const file = process.env.GIGAPHONE_SPAN_FILE;
  if (file) {
    appendFileSync(
      file,
      JSON.stringify({
        name: span.name,
        trace_id: span.trace_id,
        span_id: span.span_id,
        parent_id: span.parent_id,
        attributes: span.attributes,
      }) + "\n",
    );
    return;
  }
  const sink = globalThis.__GIGAPHONE_SINK__;
  if (typeof sink === "function") sink(span);
}

function isThenable(x) {
  return x != null && typeof x.then === "function";
}

/**
 * Curried, async-correct boundary tracer: `gigaphoneTrace(opts)(fn)` runs `fn` inside a new
 * span nested under the current one, records `opts.output` (dotted paths into the return
 * value) as `gigaphone.output.*`, then returns whatever `fn` returned. The span is ended
 * after a returned promise settles, so async boundaries stay correctly scoped.
 */
export function gigaphoneTrace(opts = {}) {
  const { name = "boundary", kind = "tool", output = [] } = opts;
  return (fn) => {
    const parent = als.getStore();
    const span = {
      name,
      trace_id: parent ? parent.trace_id : hex(16),
      span_id: hex(8),
      parent_id: parent ? parent.span_id : null,
      attributes: { "gigaphone.kind": kind },
    };
    const ctx = { trace_id: span.trace_id, span_id: span.span_id };
    const finish = (result) => {
      recordOutput(span, result, output);
      emit(span);
      return result;
    };
    const fail = (err) => {
      span.attributes["gigaphone.error"] = String((err && err.message) || err);
      emit(span);
      throw err;
    };
    return als.run(ctx, () => {
      let result;
      try {
        result = fn();
      } catch (err) {
        return fail(err);
      }
      return isThenable(result) ? result.then(finish, fail) : finish(result);
    });
  };
}

/**
 * OFF_CONTEXT fix: wrap an executor/pool so callables it runs carry the submitting context,
 * re-parenting worker spans under the agent trace instead of orphaning them. Idempotent.
 */
export function gigaphonePropagate(executor) {
  if (!executor || executor.__gigaphonePropagating) return executor;
  const store = als.getStore();
  for (const method of ["run", "submit", "map", "exec", "schedule"]) {
    const orig = executor[method];
    if (typeof orig === "function") {
      executor[method] = (fn, ...rest) =>
        orig.call(executor, (...a) => als.run(store, () => fn(...a)), ...rest);
    }
  }
  executor.__gigaphonePropagating = true;
  return executor;
}

/**
 * LOSSY_OUTPUT fix: record the complete output on an already-open span (the customer's span
 * object, OTel or vendor — anything with `setAttribute`; our own span objects also work).
 */
export function gigaphoneComplete(span, value, fields = []) {
  if (!span) return;
  const set = (k, v) => {
    if (typeof span.setAttribute === "function") span.setAttribute(k, v);
    else if (span.attributes) span.attributes[k] = v;
  };
  if (fields && fields.length) {
    for (const f of fields) set(`gigaphone.output.${f}`, stringify(resolve(value, f)));
  } else {
    set("gigaphone.output", stringify(value));
  }
}
