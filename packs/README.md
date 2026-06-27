# Language packs (the *language* axis)

Each pack carries everything language-specific so the engine, classifier, specs, plan
records, and both adapters stay language-neutral. A pack = a parser + anchor matching +
def-use + `off_context` hop-signatures + codemod emitters. The `LanguagePack` interface is
parser-agnostic (ADR-0007), so each pack picks its parser. See
`src/gigaphone/interfaces/language_pack.py` and DESIGN §7.

- `python/` — v1 (M2). stdlib `ast` (ADR-0007); contextvars / thread-pool /
  `run_in_executor` hop-signatures.
- `typescript/` — v1 (M6). tree-sitter CST when `tree-sitter` + `tree-sitter-typescript`
  are installed, else a lexical (regex/brace) fallback (ADR-0007); AsyncLocalStorage /
  worker_threads.
- `rust/` — v1. lexical (regex/brace-scanning); `tracing`-crate spans; `tokio::spawn` /
  `std::thread::spawn` / thread-pool hop-signatures; `match`-based tool dispatch.

A new language is a new pack here, with **no engine change**.
