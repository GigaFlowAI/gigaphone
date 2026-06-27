"""Optional tree-sitter-backed function scanner for the TypeScript pack (DESIGN §7; ADR-0007).

When ``tree-sitter`` + ``tree-sitter-typescript`` are installed, the pack scans functions
from a real concrete syntax tree instead of the lexical regex/brace fallback — byte-precise
and immune to the lexical limitations (generics carrying ``>``/``{``, braces inside a
template/string in a header, arrow functions with no parenthesised parameter list).

Import-guarded: when the wheels are absent the pack uses its lexical scanner and CI stays
headless (the ADR-0007 concern). ``scan`` returns the same record shape the lexical scanner
produces — CHAR indices into ``source`` — so the rest of the pack is parser-agnostic.
"""

from __future__ import annotations

_PARSER = None


def available() -> bool:
    try:
        import tree_sitter  # noqa: F401
        import tree_sitter_typescript  # noqa: F401
    except ImportError:
        return False
    return True


def _parser():
    global _PARSER
    if _PARSER is None:
        import tree_sitter_typescript as tst
        from tree_sitter import Language, Parser

        _PARSER = Parser(Language(tst.language_typescript()))
    return _PARSER


def scan(source: str) -> list[dict]:
    """Return function records ``{name, header_char, body_open, body_close, class_name,
    indent}`` with CHAR indices into ``source`` — matching the lexical scanner's shape.

    Collected node kinds (block-bodied only, mirroring the lexical scanner's coverage):
    free ``function_declaration``s, class ``method_definition``s (with the enclosing class
    name), and ``const``/``let`` arrow functions bound to a ``variable_declarator``.
    """
    sb = source.encode("utf-8")
    root = _parser().parse(sb).root_node

    def b2c(b: int) -> int:  # byte offset -> char index (identity for ASCII)
        return len(sb[:b].decode("utf-8", "ignore"))

    def line_start_char(c: int) -> int:
        return source.rfind("\n", 0, c) + 1

    def indent_at(c: int) -> str:
        line = source[line_start_char(c) : c]
        return line[: len(line) - len(line.lstrip())]

    out: list[dict] = []

    def emit(name_node, body_node, decl_start_byte: int, class_name: str | None) -> None:
        if name_node is None or body_node is None or body_node.type != "statement_block":
            return
        decl_c = b2c(decl_start_byte)
        out.append(
            {
                "name": name_node.text.decode("utf-8"),
                "header_char": line_start_char(decl_c),
                "body_open": b2c(body_node.start_byte),
                "body_close": b2c(body_node.end_byte) - 1,
                "class_name": class_name,
                "indent": indent_at(decl_c),
            }
        )

    def visit(node, class_name: str | None = None) -> None:
        t = node.type
        if t == "function_declaration":
            emit(
                node.child_by_field_name("name"),
                node.child_by_field_name("body"),
                node.start_byte,
                None,
            )
        elif t == "class_declaration":
            cls = node.child_by_field_name("name")
            cls_name = cls.text.decode("utf-8") if cls else None
            body = node.child_by_field_name("body")
            if body is not None:
                for m in body.children:
                    if m.type == "method_definition":
                        emit(
                            m.child_by_field_name("name"),
                            m.child_by_field_name("body"),
                            m.start_byte,
                            cls_name,
                        )
            for c in node.children:
                visit(c, cls_name)
            return
        elif t == "variable_declarator":
            value = node.child_by_field_name("value")
            if value is not None and value.type == "arrow_function":
                emit(
                    node.child_by_field_name("name"),
                    value.child_by_field_name("body"),
                    node.start_byte,
                    None,
                )
        for c in node.children:
            visit(c, class_name)

    visit(root)
    return out
