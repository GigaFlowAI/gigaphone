"""Tiny stdlib YAML reader/writer for ``gigaphone.boundaries.yaml`` — zero dependencies.

GigaPhone ships as a dependency-free plugin (run by a bare ``python3``), so it cannot rely
on PyYAML. The boundary config is a small, well-defined schema we fully control, so a
focused serializer/parser is enough. Supported subset (documented for hand-writers):

- a top-level ``boundaries:`` block sequence of mappings
- mapping values are scalars, flow maps ``{k: v, ...}``, flow lists ``[a, b]``, or a
  one-level block mapping
- ``#`` comments, blank lines, single/double-quoted or plain scalars

The writer always emits flow-style leaf maps, which is the form ``load`` round-trips.
"""

from __future__ import annotations

from typing import Any

_SPECIAL = set(":#{}[],&*!|>'\"%@`")


# --------------------------------------------------------------------------- writer
def _needs_quote(s: str) -> bool:
    return s == "" or s[0] in _SPECIAL or s[0] in " " or s[-1] in " " or any(c in s for c in ":#")


def _scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return str(value)
    s = str(value)
    if _needs_quote(s):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def _flow(value: Any) -> str:
    if isinstance(value, dict):
        return "{" + ", ".join(f"{k}: {_flow(v)}" for k, v in value.items()) + "}"
    if isinstance(value, list):
        return "[" + ", ".join(_flow(v) for v in value) + "]"
    return _scalar(value)


def dump(doc: dict) -> str:
    """Serialize ``{"boundaries": [mapping, ...]}`` to YAML (flow-style leaf maps)."""
    out: list[str] = []
    boundaries = doc.get("boundaries", []) or []
    out.append("boundaries:")
    if not boundaries:
        out[-1] = "boundaries: []"
    for item in boundaries:
        first = True
        for k, v in item.items():
            prefix = "- " if first else "  "
            out.append(f"{prefix}{k}: {_flow(v)}")
            first = False
        if first:  # empty mapping item
            out.append("- {}")
    return "\n".join(out) + "\n"


# --------------------------------------------------------------------------- reader
def _strip_comment(line: str) -> str:
    in_q: str | None = None
    for i, c in enumerate(line):
        if in_q:
            if c == in_q:
                in_q = None
        elif c in "\"'":
            in_q = c
        elif c == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def _split_top(s: str, sep: str) -> list[str]:
    """Split on ``sep`` at depth 0, respecting quotes and {}/[] nesting."""
    parts: list[str] = []
    depth = 0
    in_q: str | None = None
    start = 0
    for i, c in enumerate(s):
        if in_q:
            if c == in_q:
                in_q = None
        elif c in "\"'":
            in_q = c
        elif c in "{[":
            depth += 1
        elif c in "}]":
            depth -= 1
        elif c == sep and depth == 0:
            parts.append(s[start:i])
            start = i + 1
    parts.append(s[start:])
    return [p for p in (p.strip() for p in parts) if p != ""] if s.strip() else []


def _unquote(s: str) -> Any:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    if s in ("null", "~", ""):
        return None
    if s == "true":
        return True
    if s == "false":
        return False
    return s


def _parse_value(s: str) -> Any:
    s = s.strip()
    if s.startswith("{") and s.endswith("}"):
        inner = s[1:-1].strip()
        d: dict = {}
        for pair in _split_top(inner, ","):
            k, _, v = pair.partition(":")
            d[k.strip()] = _parse_value(v)
        return d
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        return [_parse_value(v) for v in _split_top(inner, ",")]
    return _unquote(s)


def load(text: str) -> dict:
    """Parse a boundaries config into ``{"boundaries": [mapping, ...]}``.

    A block sequence of mappings whose leaf values are scalars or flow maps/lists — the
    form ``dump`` emits and the documented hand-write subset. Returns an empty list if
    there is no resolvable ``boundaries:`` content.
    """
    # de-commented, non-blank lines as (content) — the schema is one level of nesting
    # (boundaries → list of flat maps), so we don't need indentation tracking.
    rows: list[str] = []
    for raw in text.splitlines():
        line = _strip_comment(raw).strip()
        if line:
            rows.append(line)

    try:
        start = next(i for i, r in enumerate(rows) if r.startswith("boundaries:"))
    except StopIteration:
        return {"boundaries": []}
    if rows[start].replace(" ", "").endswith("[]"):
        return {"boundaries": []}

    boundaries: list[dict] = []
    cur: dict | None = None
    for content in rows[start + 1 :]:
        if content.startswith("- "):
            cur = {}
            boundaries.append(cur)
            content = content[2:].strip()
        elif content.startswith("-"):  # bare "-" then keys on following lines
            cur = {}
            boundaries.append(cur)
            continue
        if cur is None:
            break  # content before any list item → not part of boundaries
        if content:
            key, _, val = content.partition(":")
            cur[key.strip()] = _parse_value(val)
    return {"boundaries": boundaries}
