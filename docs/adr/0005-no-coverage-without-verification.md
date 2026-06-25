# ADR-0005: No tool is "covered" without a backend verify()

- Status: Accepted
- Date: 2026-06-25

## Context

The dangerous failure mode is a **false negative** dressed as success: GigaPhone
applies a fix, reports the tool as covered, and the span still never lands nested and
complete in the customer's backend. Self-assessment by the engine ("I inserted a
decorator") is not evidence. The only evidence is the span appearing where the eval
platform reads it.

## Decision

A tool is counted as covered only after `backend_adapter.verify(...)` confirms the
expected tool span appears **nested under the correct agent trace with a complete
payload**, read via the same path the eval platform uses (DESIGN §12). Verification is
deterministic tooling, not agent judgment.

When no representative path is runnable, the fallback is instrument → wait for live
traffic → verify asynchronously; the tool stays *unverified* (not *covered*) until then.

## Consequences

- Every fix needs a demonstrable before/after: pair each fixable failure mode with a
  *breaking* fixture so the fix is provable (golden principle).
- The onboarding report's coverage numbers mean "verified," not "attempted."
- Backend adapters must implement a real `verify()`, not a stub, to count toward v1.
