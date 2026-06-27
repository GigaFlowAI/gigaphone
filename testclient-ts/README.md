# TypeScript onboarding testclient

Mirrors `testclient/` (Python) for the TypeScript language pack. A tiny agent with two
*untraced* tool boundaries (`runCode`, `webSearch`) registered in a `TOOLS` map, plus a
representative path that owns the agent root span.

The e2e (`tests/test_e2e_typescript_onboarding.py`) copies this into a temp project, vendors
the runtime shim as `@gigaphone/otel` in `node_modules`, then proves the red → green →
idempotent cycle: before the fix the tool spans are missing; after `gigaphone fix` wraps the
boundaries they land nested under the agent root and complete; re-detecting finds nothing
left to fix.

Files are erasable TypeScript so Node runs them directly via type-stripping (Node ≥ 23.6) —
the same `.ts` files GigaPhone edits are the ones executed during `verify`.
