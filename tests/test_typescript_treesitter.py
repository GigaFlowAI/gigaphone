"""Tree-sitter backend for the TypeScript pack (ADR-0007).

Guarantees: (1) the whole existing TS suite (``test_typescript_pack`` +
``test_e2e_typescript_onboarding``) runs under the tree-sitter scanner whenever the wheels
are installed — fixture parity; (2) the tree-sitter scanner additionally parses constructs
the lexical scanner cannot (bare arrow consts, generics carrying ``{``/``>`` in the header);
(3) on source both backends handle, their ``_Func`` records are identical; and (4) the pack
still works with tree-sitter forced off (the headless-CI fallback).
"""

from __future__ import annotations

import pytest

from gigaphone.core.boundary import BoundaryKind, FailureMode
from gigaphone.packs.typescript import TypeScriptPack, _treesitter
from gigaphone.packs.typescript import pack as ts_pack

_needs_ts = pytest.mark.skipif(
    not _treesitter.available(), reason="tree-sitter wheels not installed"
)

# A class method, a free function, and a *bare* arrow const (no type annotation).
PARITY_SRC = """\
import { trace } from "@opentelemetry/api";

export class Gateway {
  async chat(messages: Message[]): Promise<Reply> {
    return this.plan(messages);
  }
}

export function runCode(code: string): Result {
  return execSync(code);
}

export const helper = (x: number) => {
  return x + 1;
};
"""

# Source both backends handle identically (typed arrow with a plain type, no `=>` in it).
AGREE_SRC = """\
export function runCode(code: string): Result {
  return execSync(code);
}

export const helper: Helper = (x: number) => {
  return x + 1;
};
"""


def _norm_func(f) -> tuple:
    return (f.name, f.header_char, f.body_open, f.body_close, f.class_name, f.indent)


def _norm_rec(r: dict) -> tuple:
    return tuple(
        r[k] for k in ("name", "header_char", "body_open", "body_close", "class_name", "indent")
    )


@_needs_ts
def test_treesitter_finds_function_method_and_arrow():
    recs = {r["name"]: r for r in _treesitter.scan(PARITY_SRC)}
    assert set(recs) == {"chat", "runCode", "helper"}
    assert recs["chat"]["class_name"] == "Gateway"  # method carries its enclosing class
    assert recs["runCode"]["class_name"] is None
    # the bare arrow const is exactly what the lexical scanner cannot see:
    assert "helper" not in {f.name for f in ts_pack._scan_functions_lexical(PARITY_SRC)}


@_needs_ts
def test_dispatcher_prefers_treesitter_when_available():
    # _scan_functions returns the full set incl. the arrow const → the tree-sitter backend
    # (not lexical, which would drop `helper`) is the one in use.
    assert {f.name for f in ts_pack._scan_functions(PARITY_SRC)} == {"chat", "runCode", "helper"}


@_needs_ts
def test_backends_agree_byte_for_byte_on_source_both_handle():
    lexical = sorted(_norm_func(f) for f in ts_pack._scan_functions_lexical(AGREE_SRC))
    tree = sorted(_norm_rec(r) for r in _treesitter.scan(AGREE_SRC))
    assert tree == lexical


@_needs_ts
def test_treesitter_parses_generic_header_the_lexical_scanner_misses():
    # A generic type parameter with an object constraint sits between the name and the `(`,
    # which the lexical `function name(` regex cannot match — tree-sitter parses it.
    src = (
        "export function runTool<T extends { id: number }>(code: string): T {\n"
        "  return execSync(code);\n"
        "}\n"
    )
    assert "runTool" not in {f.name for f in ts_pack._scan_functions_lexical(src)}
    assert "runTool" in {r["name"] for r in _treesitter.scan(src)}


def test_pack_falls_back_to_lexical_when_treesitter_absent(monkeypatch):
    # Force the headless-CI path: no wheels → lexical scanner. Discovery + analysis of the
    # exec-sink tool must still work, proving the fallback is wired and equivalent.
    monkeypatch.setattr(_treesitter, "available", lambda: False)
    src = (
        "export function runCode(code: string): Result {\n"
        "  return execSync(code);\n"
        "}\n"
        "export const TOOLS: Record<string, Function> = { run_code: runCode };\n"
    )
    pack = TypeScriptPack()
    descs = pack.discover("app/agent.ts", src)
    tool = next((d for d in descs if d.match_call == "app.agent.runCode"), None)
    assert tool is not None and tool.kind == BoundaryKind.TOOL_EXEC
    bs = {b.func_name: b for b in pack.analyze("app/agent.ts", src, descs)}
    assert bs["runCode"].failure_modes == [FailureMode.UNTRACED]
