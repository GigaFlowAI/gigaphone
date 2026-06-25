# ADR-0003: Trace the consumption boundary; treat the sandbox as a black box

- Status: Accepted
- Date: 2026-06-25

## Context

Code-execution tools run in varied sandboxes — subprocess, Docker, E2B, modal, remote
workers. Instrumenting *inside* every sandbox is intractable and axis-specific. The
naive approach — "add a tracing decorator wherever one is missing" — is wrong and can
make things worse: the real failure is rarely a missing decorator but a result produced
*outside* the agent's span context or logged in a *lossy* shape.

## Decision

We instrument the **in-process consumption boundary**: the layer that receives the
execution output and feeds it back to the agent's model, which always runs on the
normal call stack inside the agent's span context. We treat the sandbox itself as a
black box and do not instrument inside it (v1 non-goal).

Discovery finds this boundary without hardcoding the harness, language, vendor, or
codebase — it is the seam that is neutral on all four axes (ADR-0002).

## Consequences

- One instrumentation site per tool path regardless of sandbox technology.
- The failure-mode taxonomy (`no_boundary` / `untraced` / `off_context` / `lossy_output`)
  is defined relative to this boundary and is invariant across all four axes (DESIGN §10).
- In-sandbox sub-spans are explicitly deferred to v2.
