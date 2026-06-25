# Language packs (the *language* axis)

Each pack carries everything language-specific so the engine, classifier, specs, plan
records, and both adapters stay language-neutral. A pack = grammar + anchor queries +
shallow def-use + `off_context` hop-signatures + codemod emitters. See
`src/gigaphone/interfaces/language_pack.py` and DESIGN §7.

- `python/` — v1 (M2). tree-sitter-python; contextvars / thread-pool / `run_in_executor`
  hop-signatures. `queries/` holds the S-expression anchor queries.
- `typescript/` — v1 (M6). tree-sitter-typescript; AsyncLocalStorage / worker_threads.

A new language is a new pack here, with **no engine change**.
