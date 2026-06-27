# Language packs (the *language* axis)

Each pack carries everything language-specific so the engine, classifier, specs, plan
records, and all adapters stay language-neutral. A pack = a parser + anchor matching +
def-use + `off_context` hop-signatures + codemod emitters. The `LanguagePack` interface is
parser-agnostic (ADR-0007), so each pack picks its parser. See
`src/interfaces/languagePack.ts` and DESIGN §7. Packs live in `src/packs/<lang>/` and
register in `src/packs/registry.ts`.

- `python/` — python3 stdlib `ast` via a `python3` bridge (`astDump.py`, ADR-0007): the TS
  engine shells out to the interpreter to get exact source locations, then maps them to byte
  ranges for clean idempotent codemods. contextvars / thread-pool / `run_in_executor`
  hop-signatures.
- `typescript/` — a lexical (regex/brace) scanner plus a **precise** scanner backed by the
  TypeScript compiler API (`precise.ts`) when `typescript` is importable, else the lexical
  fallback (ADR-0007). Both produce the same `Func` records, so neutrality holds.
  AsyncLocalStorage / worker_threads.
- `rust/` — lexical (regex/brace-scanning); `tracing`-crate spans; `tokio::spawn` /
  `std::thread::spawn` / thread-pool hop-signatures; `match`-based tool dispatch.

A new language is a new pack here, with **no engine change**.
