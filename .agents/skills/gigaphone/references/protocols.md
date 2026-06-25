# Protocol contracts (reference — loaded on demand)

Both protocols are **JSON-in / ranges-to-read / JSON-out** so any harness fulfills them
identically. The engine schema-validates every response and re-prompts on mismatch.

## Boundary descriptor (Discovery protocol output)

The unit you propose during `gigaphone discover`. Many descriptors converge into one
committed `gigaphone.boundaries.yaml` (see `/examples/gigaphone.boundaries.yaml`).

```yaml
- id: acme-coderunner               # stable, kebab-case
  kind: tool_exec                   # llm | tool_exec | tool_result_sink
  match: { call: "sandbox.execute" } # dotted name → per-language query (raw TS pattern = escape hatch)
  input:  { arg: "code" }
  output: { paths: ["result.stdout", "result.stderr", "result.exit_code"] }  # complete result → fixes lossy_output
  emit:   { name: "acme.exec" }     # span type is set by the backend adapter from `kind`
```

`kind` semantics:
- `llm` — the gateway call that talks to the model.
- `tool_exec` — the function wrapping execution (subprocess/exec/sandbox). Trace the
  wrapper, never inside the sandbox.
- `tool_result_sink` — where the tool result is written back into the message list
  (`role: tool` / `function_call_output` / `tool_result` / `ToolMessage`).

## unresolved.json (Resolution protocol input — emitted by the engine)

```json
{
  "unresolved": [
    {
      "id": "exec-dispatch-7",
      "anchor": "tools/run.py:88",
      "read_ranges": [["tools/run.py", 60, 140], ["tools/pool.py", 1, 40]],
      "question": "Which function consumes the subprocess result and returns it to the agent loop?",
      "answer_schema": { "boundary_call": "string (dotted)", "failure_modes": "string[]", "complete_output_fields": "string[]" }
    }
  ]
}
```

## resolution.json (Resolution protocol output — you write it)

```json
{
  "resolutions": [
    {
      "id": "exec-dispatch-7",
      "boundary_call": "runner._collect",
      "failure_modes": ["off_context", "lossy_output"],
      "complete_output_fields": ["stdout", "stderr", "exit_code"]
    }
  ]
}
```

If an item genuinely cannot be resolved, return it with `"unresolvable": true` and a
reason rather than guessing. The engine surfaces it in the report; it is never silently
skipped.
