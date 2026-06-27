# GigaPhone TypeScript runtime shim

The call sites GigaPhone's TypeScript codemods emit (`gigaphoneTrace`, `gigaphonePropagate`,
`gigaphoneComplete`) resolve to this shim. It mirrors the Python shim in
`src/gigaphone/runtime/` one-for-one and is dependency-free (Node built-ins only).

`gigaphone-core.mjs` is the implementation; `gigaphone-core.d.ts` are its types.

## Publishing

Each backend ships as a tiny package whose entry point **is** this core (the per-backend
difference is the customer's one-time exporter init at the telemetry-init site, not these
call sites — Braintrust and LangSmith both ingest the OTLP/OpenInference shape):

- `@gigaphone/otel`
- `@gigaphone/braintrust`
- `@gigaphone/langsmith`

A fix emitted for `--backend braintrust` imports `@gigaphone/braintrust`; install the
matching package. The `package.template.json` here is the per-package manifest (set `name`).

## Verification

When `GIGAPHONE_SPAN_FILE` is set, `gigaphoneTrace` appends each finished span as one JSON
line — the same read path `gigaphone verify` uses (and the same shape the Python testclient
exporter emits), so a fixed TypeScript app is verified end-to-end by running it under Node
with that env var set. With no span file, it forwards to `globalThis.__GIGAPHONE_SINK__` if
present, else is a no-op so fixed code always runs.
