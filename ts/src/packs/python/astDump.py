"""Python AST dump helper for the TypeScript Python language pack (ADR-0007 port).

The TS engine cannot use the stdlib ``ast`` module directly, so this script is the bridge:
it reads Python source from stdin, parses it with ``ast.parse``, and prints a GENERIC JSON
serialization of the tree to stdout. The TS pack reimplements all pack logic over that JSON.

Serialization (one object per ``ast.AST`` node)::

    {
      "type": <ClassName>,            # e.g. "FunctionDef", "Call", "Name"
      "_fields": [<field-name>, ...], # node._fields, in order (drives the walk)
      "lineno": <int>,                # present when the node carries position info
      "col_offset": <int>,
      "end_lineno": <int>,            # present when available
      "end_col_offset": <int>,
      <field>: <serialized child>,    # each AST field, recursively serialized
      ...
    }

A child is serialized as: a node object (nested AST), an array (list field), a JSON
primitive (str/int/float/bool/None), or ``{"__repr__": <str>}`` for values that are not
JSON-representable (bytes, complex, Ellipsis).

Default mode reads source on stdin and prints the tree. On a ``SyntaxError`` it prints
``{"__error__": "syntax"}`` and exits 0 (callers treat that as "no descriptors").

``--strings`` mode reads source on stdin and prints a JSON array of the 1-based physical
line numbers that are interior to multi-line string tokens (mirrors
``_multiline_string_interior_lines`` in the Python pack), or ``[]`` on a ``TokenError``.
"""

import ast
import io
import json
import sys
import tokenize as _tokenize

_POS_ATTRS = ("lineno", "col_offset", "end_lineno", "end_col_offset")


def _ser(node):
    if isinstance(node, ast.AST):
        out = {"type": type(node).__name__, "_fields": list(node._fields)}
        for attr in _POS_ATTRS:
            if hasattr(node, attr):
                value = getattr(node, attr)
                if value is not None:
                    out[attr] = value
        for field in node._fields:
            out[field] = _ser(getattr(node, field, None))
        return out
    if isinstance(node, list):
        return [_ser(item) for item in node]
    # bool is a subclass of int; str/int/float/None are JSON-native.
    if node is None or isinstance(node, (str, bool, int, float)):
        return node
    # bytes, complex, Ellipsis, and any other Constant payloads.
    return {"__repr__": repr(node)}


_STRING_TOKEN_TYPES = frozenset(
    getattr(_tokenize, _name)
    for _name in (
        "STRING",
        "FSTRING_START",
        "FSTRING_MIDDLE",
        "FSTRING_END",
        "TSTRING_START",
        "TSTRING_MIDDLE",
        "TSTRING_END",
    )
    if hasattr(_tokenize, _name)
)


def _multiline_string_interior_lines(body_text):
    interior = set()
    try:
        tokens = list(_tokenize.generate_tokens(io.StringIO(body_text).readline))
    except _tokenize.TokenError:
        return []
    for tok in tokens:
        if tok.type in _STRING_TOKEN_TYPES and tok.end[0] > tok.start[0]:
            for ln in range(tok.start[0] + 1, tok.end[0] + 1):
                interior.add(ln)
    return sorted(interior)


def main():
    src = sys.stdin.read()
    if len(sys.argv) > 1 and sys.argv[1] == "--strings":
        json.dump(_multiline_string_interior_lines(src), sys.stdout)
        return
    try:
        tree = ast.parse(src)
    except SyntaxError:
        json.dump({"__error__": "syntax"}, sys.stdout)
        return
    json.dump(_ser(tree), sys.stdout)


if __name__ == "__main__":
    main()
