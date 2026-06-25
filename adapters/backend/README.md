# Backend adapters (the *vendor* axis)

The entire vendor-specific surface: emit + verify. See
`src/gigaphone/interfaces/backend_adapter.py` and DESIGN §9.

Two tiers:
- `otel/` — generic OTel / OpenInference; targets any OTLP backend (new platform =
  endpoint + headers, no code). v1 (M3).
- `braintrust/`, `langsmith/` — native adapters (contextvars family) that override where
  native semantics win. v1 (M6).

Selection: OTel present → OTel adapter; native SDK present → that adapter; else the
customer's platform.
