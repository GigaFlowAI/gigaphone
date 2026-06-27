# ADR-0007: The Python language pack uses stdlib `ast`; tree-sitter stays the cross-language substrate

- Status: Accepted
- Date: 2026-06-25
- Amends: DESIGN §7 (which named tree-sitter as the toolchain for every pack)

## Context

DESIGN §7 chose tree-sitter as the enabling toolchain across all language packs (one
query toolchain, byte ranges, error-tolerant parsing). That reasoning holds for the
*cross-language* goal. But for the **Python** pack specifically, the standard library's
`ast` module is a better v1 choice: zero extra dependency, zero grammar-build/wheel risk,
exact source locations (`lineno`/`col_offset`/`end_*`) that map to byte ranges for clean
idempotent codemods, and a parser that is always version-matched to the analyzed code.

## Decision

The Python pack (`gigaphone.packs.python`) is implemented on stdlib `ast`. The
`LanguagePack` interface is therefore **parser-agnostic**: it exposes `analyze()` /
`emit_fix()` over a neutral core model (`Boundary`, `CodeEdit`), not tree-sitter types.
tree-sitter remains the planned substrate for packs where no equally-good native parser
ships with the runtime (e.g. the TypeScript pack).

## Consequences

- The Python pack adds no third-party parse dependency and cannot break on a grammar wheel.
- Codemods stay byte-accurate via `ast` offsets, satisfying the idempotent-edit golden principle.
- The neutrality contract is unchanged: the engine still talks only to the `LanguagePack`
  interface and never sees a parser type (ADR-0002). Swapping a pack's parser is invisible
  to the core.
- Per-pack parser choice is allowed; the def-use and `off_context` *contracts* (DESIGN §16)
  remain part of the pack spec so coverage stays consistent across packs regardless of parser.
- The TypeScript pack realises this with a precise scanner backed by the **TypeScript
  compiler API** (`src/packs/typescript/precise.ts`), used when `typescript` is importable and
  falling back to a lexical scanner otherwise. (After the TS rewrite the engine itself is Node,
  so reusing the codebase's own compiler is more natural than a tree-sitter grammar; an earlier
  Python-engine iteration used tree-sitter-typescript here.) Both backends emit the same `Func`
  records, so the neutrality contract above is preserved.
- The **Python** pack, now that the engine is TypeScript, reaches CPython's `ast` through a
  bundled `python3` bridge (`astDump.py`) — the same stdlib parser, exact source locations
  intact, no JS reimplementation of Python parsing.
