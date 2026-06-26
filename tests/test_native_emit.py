"""Tests for native OTLP body-wrap codemod (Task NM1)."""
from __future__ import annotations

import ast

import pytest

from gigaphone.core.model import CodeEdit
from gigaphone.packs.python.pack import native_otel_body_wrap


def _apply(source: str, edit: CodeEdit) -> str:
    # apply hunks back-to-front by byte offset
    b = source.encode("utf-8")
    for h in sorted(edit.hunks, key=lambda h: h.byte_start, reverse=True):
        b = b[: h.byte_start] + h.new_text.encode("utf-8") + b[h.byte_end :]
    return b.decode("utf-8")


SYNC = """\
def run(x):
    a = work(x)
    return a
"""

ASYNC = """\
async def run(x):
    a = await work(x)
    return a
"""

ASYNC_GEN = """\
async def run(x):
    a = build(x)
    async for t in client.post(x):
        yield t
"""

WITH_DOCSTRING = """\
def run(x):
    \"\"\"Do the work.\"\"\"
    a = work(x)
    return a
"""


def test_body_wrap_sync_compiles_and_nests():
    edit = native_otel_body_wrap(SYNC, "run", "svc.run", "tool")
    out = _apply(SYNC, edit)
    ast.parse(out)  # still valid Python
    assert "from opentelemetry import trace" in out
    assert 'start_as_current_span("svc.run")' in out or "start_as_current_span('svc.run')" in out
    assert "gigaphone:trace:run" in out
    # the with-block is the body: the assignment is now indented under it
    assert "\n        a = work(x)" in out


def test_body_wrap_async_stays_async():
    out = _apply(ASYNC, native_otel_body_wrap(ASYNC, "run", "svc.run", "tool"))
    tree = ast.parse(out)
    # The import is prepended, so walk to find the function (not body[0])
    fn = next(
        n for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "run"
    )
    assert type(fn).__name__ == "AsyncFunctionDef"
    assert "await work(x)" in out


def test_body_wrap_async_generator_keeps_yield_inside_span():
    out = _apply(ASYNC_GEN, native_otel_body_wrap(ASYNC_GEN, "run", "svc.run", "agent"))
    tree = ast.parse(out)
    # still an async generator (has a yield), and the yield is nested under the with-block
    assert "yield t" in out
    src_lines = out.splitlines()
    with_line = next(i for i, l in enumerate(src_lines) if "start_as_current_span" in l)
    yield_line = next(i for i, l in enumerate(src_lines) if "yield t" in l)
    assert yield_line > with_line
    # the yield is indented deeper than the with-header
    assert (len(src_lines[yield_line]) - len(src_lines[yield_line].lstrip())) > (
        len(src_lines[with_line]) - len(src_lines[with_line].lstrip())
    )
    assert 'span.set_attribute("gigaphone.kind", "agent")' in out or \
           "span.set_attribute('gigaphone.kind', 'agent')" in out


def test_body_wrap_idempotent():
    once = _apply(SYNC, native_otel_body_wrap(SYNC, "run", "svc.run", "tool"))
    assert native_otel_body_wrap(once, "run", "svc.run", "tool") is None


def test_body_wrap_docstring_preserved_outside_span():
    """Docstring stays outside (before) the with-block."""
    out = _apply(WITH_DOCSTRING, native_otel_body_wrap(WITH_DOCSTRING, "run", "svc.run", "tool"))
    ast.parse(out)
    lines = out.splitlines()
    doc_line = next(i for i, l in enumerate(lines) if '"""Do the work."""' in l)
    with_line = next(i for i, l in enumerate(lines) if "start_as_current_span" in l)
    assert doc_line < with_line


def test_body_wrap_returns_none_for_unknown_func():
    assert native_otel_body_wrap(SYNC, "nonexistent", "svc.run", "tool") is None


def test_body_wrap_async_gen_output():
    """Print the wrapped output for eyeballing (captured in the report)."""
    out = _apply(ASYNC_GEN, native_otel_body_wrap(ASYNC_GEN, "run", "svc.run", "agent"))
    print("\n--- ASYNC_GEN wrapped output ---")
    print(out)
    print("--- end ---")
    # The tree must parse and still be a valid async generator
    tree = ast.parse(out)
    # Import is prepended — walk to find the function
    fn = next(
        n for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "run"
    )
    assert type(fn).__name__ == "AsyncFunctionDef"
    # has yield somewhere in the body (making it an async gen)
    assert any(isinstance(n, ast.Yield) for n in ast.walk(fn))
