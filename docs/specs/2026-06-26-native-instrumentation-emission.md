# Design: native instrumentation emission (drop the gigaphone runtime shim)

Status: approved direction (conversation), pending implementation
Date: 2026-06-26
Branch: `feat/native-emission` (stacked on `feat/agent-call-boundary` / PR #11)
Related: DESIGN §9 (vendor axis), ADR-0003; supersedes the emitted-shim half of the fix layer.

## Problem

Today GigaPhone's fix writes a **gigaphone-branded wrapper** into the customer's source —
`from gigaphone.runtime.otel import gigaphone_trace` + `@gigaphone_trace(...)`. Two issues:

1. **It injects a runtime dependency on GigaPhone** into the customer's code. A Braintrust or
   Arize/OpenInference shop wants their code to read in *their* SDK's idiom, not import a
   `gigaphone.runtime` shim.
2. **The shim is synchronous-only and silently breaks on async.** Verified on real OpenHands:
   `_start_app_conversation` is an `async def … yield …` (async generator). The shim's
   `wrapper` (`runtime/otel.py:53`) is a plain `def`; `fn(...)` returns the generator object
   without running the body, `_record_output` reads garbage off it, and the span opens+closes
   **before any work** — the real `httpx.post` runs outside it. A span that looks instrumented
   but captures nothing.

## Decision

Emit the **customer's native instrumentation** directly; remove the `gigaphone.runtime`
import from emitted code. The `BackendAdapter` (already the vendor-axis authority) yields the
native fix; the language pack places it. Async correctness comes from the vendor's own async
support (or, for bare OTLP, from a body-wrap that is async-correct by construction).

## Native fix per vendor (UNTRACED — the headline case)

| Backend | Detected by | Native fix |
|---|---|---|
| Braintrust | `braintrust` import present | `import braintrust` + `@braintrust.traced` (auto-logs args + complete return; handles async) |
| LangSmith | `langsmith` import | `from langsmith import traceable` + `@traceable` (auto-I/O; handles async + async-gen, accumulates) |
| Logfire | `logfire` import | `import logfire` + `@logfire.instrument()` |
| OpenInference/Phoenix | `openinference`/`phoenix` import | native span decorator if present, else the bare-OTLP body-wrap |
| **bare OTLP** (no SDK) | OTel present, no rich SDK | **body-wrap** (below) |

### Bare-OTLP body-wrap (decision (1))

OpenTelemetry has no "trace a function and log its return" decorator, so a decorator can't
express it without a helper. Instead the codemod wraps the **function body** in a native span
block:

```python
def boundary(...):
    with trace.get_tracer(__name__).start_as_current_span("name") as span:  # gigaphone:trace:boundary
        <original body, indented one level>
        # for a plain return: span.set_attribute("output.<field>", ...) before returning
```

This is fully native (only `from opentelemetry import trace`), and **async-correct by
construction**: for `async def`, `with` works unchanged; for an async generator, the `with`
encloses the `async for`/`yield` loop so the span spans the whole stream. No sync/async
wrapper mismatch.

## Async + the stream-output nuance

- Vendor decorators (`@traced`/`@traceable`) own async handling; for async generators
  `@traceable` accumulates yielded items as the output. We rely on that.
- For the OTLP body-wrap of an **async generator**, there is no single return value — record
  **completion + yield-count** (and optionally the last item), not a fictional "full output".
  Documented as the chosen default, revisitable.

## Idempotency, lossy, off_context

- **Idempotency** via the `# gigaphone:trace:<fn>` *comment* tag on the inserted line (a
  comment, not a runtime marker) — re-runs detect and skip already-fixed boundaries.
- **lossy_output** → the native "add output to the current span" call (`span.log(output=…)`
  for Braintrust; `span.set_attribute(…)` for OTLP) — no gigaphone helper.
- **off_context** → native context copy (Braintrust contextvars / OTel `context.attach`)
  emitted inline or via the vendor's own propagation utility.

## Verify changes

`verify` must read each vendor's **native** span shape instead of `gigaphone.output.*`:
the OTel adapter reads native OTLP attributes; the Braintrust adapter reads Braintrust span
fields. The testclient exporter and expectations update to the native attribute keys.

## Scope / migration

- Affects all three kinds (`llm`/`tool_exec`/`agent_call`), all three adapters, the
  `FixPrimitive` model, the pack emitter, `verify`, and every fixture/test that asserts
  `gigaphone_trace`. The `runtime/*` shims are removed from the emit path (kept only if a
  vendor genuinely needs a tiny inline fallback — preferably none).
- This is a follow-up to the agent_call PR, not a change to its discovery half.

## Milestones

- **M1 (this plan):** UNTRACED native emission for **Braintrust (decorator)** + **bare-OTLP
  (body-wrap)**, async-correct, with `verify` reading native spans, fixtures updated, and the
  **real-OpenHands `fix` diff re-run** to confirm a sane, async-correct native edit on
  `_start_app_conversation`.
- **M2:** lossy_output + off_context native equivalents; LangSmith/Logfire decorators.

## Success criteria (M1)

1. Bare-OTLP fix on a sync function emits a native `with span` body-wrap (no gigaphone import),
   idempotent, verify green.
2. Braintrust detected → emits `@braintrust.traced`, verify reads the Braintrust span.
3. An **async-generator** fixture: the body-wrap keeps the span open across the stream and
   verify confirms nesting (the bug that real OpenHands exposed is gone).
4. Re-running `fix` on the real OpenHands `_start_app_conversation` produces a native,
   async-correct diff with no `gigaphone.runtime` import.
5. No `gigaphone.runtime` import string appears in any emitted/fixed code.
