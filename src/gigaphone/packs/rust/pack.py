"""Rust language pack — v1 **lexical** implementation.

Like the TypeScript pack, this is a pragmatic regex/brace-scanning parser, not a full CST.
It is deliberately parserless: tree-sitter-rust wheels are heavy and fragile to build in
headless CI, so v1 ships a lexical pack that covers the anchor catalog (gateway, tool
dispatch, execution sinks) and the failure-mode signatures for Rust's concurrency model —
`tokio::spawn` / `std::thread::spawn` / thread pools that drop the current `tracing` span
unless it is propagated. Per ADR-0007 a pack may choose its own parser; tree-sitter is the
planned upgrade for full byte-precise localization.

It mirrors ``PythonPack`` / ``TypeScriptPack``: ``discover`` proposes descriptors,
``analyze`` classifies failure modes, ``emit_fix`` renders idempotent, byte-accurate
codemods. Lexical limits: simple generic/parameter lists (no deeply nested `<...>` in the
header), `{ }` block bodies, and no raw-string (`r#"..."#`) escapes — string and `//`/`/* */`
comment scanning is byte-accurate, and `'a` lifetimes are distinguished from `'x'` chars.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from gigaphone.core.boundary import BoundaryKind, FailureMode, Source
from gigaphone.core.model import Boundary, CodeEdit, Descriptor, FixPrimitive, Hunk, Range
from gigaphone.interfaces.language_pack import LanguagePack

# --- built-in anchor catalog (DESIGN §7.1), Rust flavour -----------------------------
_GATEWAY_TYPE_HINTS = ("llm", "gateway", "client", "model")
_GATEWAY_METHODS = {"chat", "complete", "completion", "generate", "create", "invoke"}
# span starters across the `tracing` crate / OTel / vendor SDKs in Rust
_SPAN_STARTERS = (
    "info_span!",
    "debug_span!",
    "trace_span!",
    "warn_span!",
    "error_span!",
    "span!",
    "start_span",
    "in_scope",
)
# execution sinks: trace the wrapping function, never inside (DESIGN §3)
_EXEC_SINKS = (
    "Command::new",
    "process::Command",
    ".output(",
    ".spawn(",
    ".status(",
    "Exec::",
)
# context-hop signatures for Rust's concurrency model (DESIGN §7.1, §10). Work handed to a
# spawned task / thread-pool worker starts its own span (an orphan root) unless the current
# span is propagated across the hop.
_HOP_SIGNATURES = (
    "tokio::spawn",
    "thread::spawn",
    "rayon::spawn",
    "spawn_blocking",
    ".spawn(",
    ".execute(",
    "pool.",
)
_POOL_CTOR_RE = re.compile(
    r"\b(?:[A-Za-z_]\w*::)*[A-Za-z_]*(?:ThreadPool|Pool|Runtime|Executor)\w*::new\s*\("
)
# a model-facing truncation: `&summary[..60]`, `summary[0..60]`, or `summary.chars().take(60)`
_SLICE_RE = re.compile(r"&?\s*([A-Za-z_]\w*)\s*\[\s*(?:\d+\s*)?\.\.=?\s*\d+\s*\]")
_TAKE_RE = re.compile(r"\b([A-Za-z_]\w*)\s*\.\s*chars\s*\(\s*\)\s*\.\s*take\s*\(")
_KEYWORDS = {"if", "for", "while", "loop", "match", "return", "fn", "move", "where", "as"}

_FN_RE = re.compile(r"\bfn\s+([A-Za-z_]\w*)")
_IMPL_RE = re.compile(r"\bimpl\b([^{;]*)\{")
_STRUCT_LIT_RE = re.compile(r"\b([A-Z][A-Za-z0-9_]*)\s*\{([^{}]*)\}")


@dataclass
class _Func:
    name: str
    header_char: int  # index of the line start of the function header
    body_open: int  # index of the body `{`
    body_close: int  # index of the matching `}`
    type_name: str | None  # the `impl` type a method belongs to, else None
    indent: str


def _byte(source: str, char_idx: int) -> int:
    return len(source[:char_idx].encode("utf-8"))


def _line_start(source: str, char_idx: int) -> int:
    nl = source.rfind("\n", 0, char_idx)
    return nl + 1


def _indent_of(source: str, char_idx: int) -> str:
    ls = _line_start(source, char_idx)
    line = source[ls:char_idx]
    return line[: len(line) - len(line.lstrip())]


def _skip_string(source: str, i: int) -> int:
    """Index just past a `"..."` string literal (honouring `\\` escapes)."""
    i += 1
    n = len(source)
    while i < n:
        if source[i] == "\\":
            i += 2
            continue
        if source[i] == '"':
            return i + 1
        i += 1
    return n


def _skip_tick(source: str, i: int) -> int:
    """`'` may open a char literal (`'x'`, `'\\n'`) or a lifetime label (`'a`, `'static`).
    Return the index just past a char literal, or just past the tick for a lifetime."""
    n = len(source)
    if i + 1 < n and source[i + 1] == "\\":  # char escape literal -> find closing tick
        j = i + 2
        while j < n and source[j] != "'":
            j += 1
        return j + 1 if j < n else n
    if i + 2 < n and source[i + 2] == "'":  # single-char literal like 'x'
        return i + 3
    return i + 1  # lifetime label — consume only the tick, stay out of string mode


def _match(source: str, open_idx: int, open_ch: str, close_ch: str) -> int:
    """Index of the matching close char, skipping strings, chars and comments. -1 if
    unbalanced."""
    depth = 0
    i = open_idx
    n = len(source)
    while i < n:
        c = source[i]
        if c == '"':
            i = _skip_string(source, i)
            continue
        if c == "'":
            i = _skip_tick(source, i)
            continue
        if c == "/" and i + 1 < n and source[i + 1] == "/":
            nl = source.find("\n", i)
            i = n if nl == -1 else nl
            continue
        if c == "/" and i + 1 < n and source[i + 1] == "*":
            end = source.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _params_paren(source: str, after_name: int) -> int:
    """Index of the parameter-list `(`, skipping a generic `<...>` after the fn name."""
    n = len(source)
    i = after_name
    while i < n and source[i].isspace():
        i += 1
    if i < n and source[i] == "<":  # balanced skip of the generic param list
        depth = 0
        while i < n:
            if source[i] == "<":
                depth += 1
            elif source[i] == ">":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            i += 1
        while i < n and source[i].isspace():
            i += 1
    return i if i < n and source[i] == "(" else -1


def _body_after(source: str, paren_open: int) -> tuple[int, int] | None:
    """Given the `(` of a param list, return (body_open_idx, body_close_idx). The return
    type / `where` clause between `)` and the body `{` carry no braces in normal code."""
    paren_close = _match(source, paren_open, "(", ")")
    if paren_close == -1:
        return None
    brace = source.find("{", paren_close)
    if brace == -1:
        return None
    close = _match(source, brace, "{", "}")
    if close == -1:
        return None
    return brace, close


def _impl_type(header: str) -> str | None:
    """The Self type of an `impl` header: `impl Foo` -> Foo, `impl Trait for Foo` -> Foo."""
    header = re.sub(r"<[^>]*>", " ", header)
    if " for " in f" {header} ":
        header = header.rsplit(" for ", 1)[1]
    toks = re.findall(r"[A-Za-z_]\w*", header)
    return toks[-1] if toks else None


def _scan_functions(source: str) -> list[_Func]:
    impls: list[tuple[int, int, str | None]] = []
    for m in _IMPL_RE.finditer(source):
        brace = m.end() - 1
        close = _match(source, brace, "{", "}")
        if close != -1:
            impls.append((brace, close, _impl_type(m.group(1))))

    def enclosing_type(idx: int) -> str | None:
        for brace, close, tp in impls:
            if brace < idx < close:
                return tp
        return None

    funcs: list[_Func] = []
    for fm in _FN_RE.finditer(source):
        name = fm.group(1)
        paren = _params_paren(source, fm.end())
        if paren == -1:
            continue
        body = _body_after(source, paren)
        if body is None:
            continue
        funcs.append(
            _Func(
                name=name,
                header_char=_line_start(source, fm.start()),
                body_open=body[0],
                body_close=body[1],
                type_name=enclosing_type(fm.start()),
                indent=_indent_of(source, fm.start()),
            )
        )
    return funcs


def _module_name(path: str) -> str:
    parts = path.replace("\\", "/").split("/")
    last = parts[-1]
    if last.endswith(".rs"):
        parts[-1] = last[:-3]
    for i, p in enumerate(parts):
        if p in ("src", "crate"):
            parts = parts[i + 1 :]
            break
    # main.rs / lib.rs / mod.rs are the crate/module root — drop them from the dotted name
    return ".".join(p for p in parts if p and p not in ("main", "lib", "mod"))


def _proj(module: str) -> str:
    return module.split(".", 1)[0] or "crate"


def _import_map(source: str) -> dict[str, str]:
    """Map an imported identifier -> dotted path (best-effort, lexical)."""
    out: dict[str, str] = {}
    for m in re.finditer(r"\buse\s+([\w:]+)::\{([^}]*)\}\s*;", source):
        base = m.group(1).replace("::", ".")
        for name in m.group(2).split(","):
            name = name.strip().split(" as ")[-1].strip()
            if name:
                out[name] = f"{base}.{name}"
    for m in re.finditer(r"\buse\s+([\w:]+)\s*;", source):
        dotted = m.group(1).replace("::", ".")
        out[dotted.rsplit(".", 1)[-1]] = dotted
    return out


class RustPack(LanguagePack):
    id = "rust"
    extensions = (".rs",)

    # ------------------------------------------------------------- discovery (Phase A)
    def discover(self, path: str, source: str) -> list[Descriptor]:
        module = _module_name(path)
        imports = _import_map(source)
        funcs = _scan_functions(source)
        out: list[Descriptor] = []

        # 1) hand-rolled LLM gateway: a struct hinting gateway/llm/client with a chat-like
        #    method taking a messages/prompt/input arg. Invisible to provider anchors.
        seen_types: set[str] = set()
        for fn in funcs:
            tp = fn.type_name
            if tp is None or tp in seen_types:
                continue
            if not any(h in tp.lower() for h in _GATEWAY_TYPE_HINTS):
                continue
            if fn.name in _GATEWAY_METHODS:
                header = source[fn.header_char : fn.body_open]
                arg = next((a for a in ("messages", "prompt", "input") if a in header), None)
                out.append(
                    Descriptor(
                        id=f"{tp.lower()}-gateway",
                        kind=BoundaryKind.LLM,
                        match_call=f"{module}.{tp}.{fn.name}",
                        input_arg=arg,
                        emit_name=f"{_proj(module)}.llm",
                    )
                )
                seen_types.add(tp)

        # 2) tool dispatch: `match name { "tool" => tool_fn(..), .. }` (the idiomatic router).
        for key, fn_ident in _registry_entries(source):
            target = imports.get(fn_ident, f"{module}.{fn_ident}")
            out.append(
                Descriptor(
                    id=f"tool-{key}",
                    kind=BoundaryKind.TOOL_EXEC,
                    match_call=target,
                    emit_name=f"{_proj(module)}.{key}",
                )
            )

        # 3) fallback: a free function that wraps an execution sink, if not already a tool.
        for fn in funcs:
            if fn.name.startswith("_") or fn.type_name is not None:
                continue
            body = source[fn.body_open : fn.body_close]
            if any(s in body for s in _EXEC_SINKS) and not any(
                d.match_call.endswith(f".{fn.name}") for d in out
            ):
                out.append(
                    Descriptor(
                        id=f"tool-{fn.name}",
                        kind=BoundaryKind.TOOL_EXEC,
                        match_call=f"{module}.{fn.name}",
                        emit_name=f"{_proj(module)}.{fn.name}",
                    )
                )
        return _dedupe(out)

    # ------------------------------------------------------------- localization (Phase B)
    def analyze(self, path: str, source: str, descriptors: list[Descriptor]) -> list[Boundary]:
        module = _module_name(path)
        funcs = {f.name: f for f in _scan_functions(source)}
        boundaries: list[Boundary] = []
        for d in descriptors:
            if not _targets_module(d.match_call, module):
                continue
            name = d.match_call.rsplit(".", 1)[-1]
            fn = funcs.get(name)
            if fn is None:
                continue
            boundaries.append(self._analyze_fn(d, fn, module, path, source))
        return boundaries

    def _analyze_fn(self, d, fn: _Func, module, path, source) -> Boundary:
        rng = Range(
            path,
            _byte(source, fn.header_char),
            _byte(source, fn.body_close + 1),
            source[: fn.header_char].count("\n") + 1,
        )
        b = Boundary(
            descriptor_id=d.id,
            kind=d.kind,
            path=path,
            func_name=fn.name,
            call=d.match_call,
            range=rng,
            complete_output_fields=list(d.output_paths),
            tools_covered=[d.id.replace("tool-", "")] if d.kind == BoundaryKind.TOOL_EXEC else [],
            provider_or_framework=_proj(module),
            source=Source.SPEC,
        )
        b.emit_name = d.emit_name
        body = source[fn.body_open : fn.body_close]

        # already fixed? (idempotency at the analysis level). The untraced marker sits above
        # the header, so check the whole source by per-function tag plus the body wrappers.
        if _already_fixed(source, body, fn.name):
            return b
        if d.kind == BoundaryKind.LLM:
            return b  # gateway already traced -> covered (kept for drift)

        if not b.complete_output_fields:
            b.complete_output_fields = _infer_output_fields(source, fn)

        traced = any(s in body for s in _SPAN_STARTERS) or _has_instrument_attr(source, fn)
        hop = any(s in body for s in _HOP_SIGNATURES)

        # off_context: work offloaded across a spawned task/pool that creates its own span
        if hop and traced:
            ctor = _find_pool_ctor(source)
            if ctor is not None and not _pool_already_wrapped(source):
                b.failure_modes = [FailureMode.OFF_CONTEXT]
                b.pool_ctor_range = ctor
                b.existing_span_name = _span_name(body)
                return b

        # lossy: traced but records a truncation of a complete value
        if traced:
            lossy = _find_lossy(source, fn)
            if lossy is not None:
                value, insert_byte, indent = lossy
                b.failure_modes = [FailureMode.LOSSY_OUTPUT]
                b.span_var = _span_var(body)
                b.complete_value_expr = value
                b.span_block_insert_byte = insert_byte
                b.insert_indent = indent
                b.existing_span_name = _span_name(body)
                if not b.complete_output_fields:
                    b.complete_output_fields = [value]
                return b
            return b  # traced + complete -> covered

        # no span at the boundary -> untraced
        b.failure_modes = [FailureMode.UNTRACED]
        b.decorator_insert_byte = _byte(source, fn.header_char)
        b.insert_indent = fn.indent
        return b

    # --------------------------------------------------------------------- fix emission
    def emit_fix(self, boundary: Boundary, primitive: FixPrimitive, source: str) -> CodeEdit | None:
        import_byte = _import_insert_offset(source)
        import_hunk = Hunk(
            import_byte, import_byte, primitive.import_line + "\n", primitive.import_line
        )

        if (
            primitive.failure_mode == FailureMode.UNTRACED
            and boundary.decorator_insert_byte is not None
        ):
            at = boundary.decorator_insert_byte
            indent = boundary.insert_indent or ""
            tag = f"gigaphone:trace:{boundary.func_name}"
            deco = f"{indent}#[{primitive.decorator}]  // {tag}\n"
            return CodeEdit(
                boundary.path,
                [import_hunk, Hunk(at, at, deco, tag)],
                f"trace untraced boundary `{boundary.func_name}` ({primitive.backend_id})",
            )

        if primitive.failure_mode == FailureMode.OFF_CONTEXT and boundary.pool_ctor_range:
            start, end = boundary.pool_ctor_range
            orig = source.encode("utf-8")[start:end].decode("utf-8")
            tag = f"gigaphone:ctx:{boundary.func_name}"
            new = f"{primitive.executor_wrapper}({orig}) /* {tag} */"
            return CodeEdit(
                boundary.path,
                [import_hunk, Hunk(start, end, new, tag)],
                f"restore context across the spawned task/pool for `{boundary.func_name}` "
                f"({primitive.backend_id})",
            )

        if (
            primitive.failure_mode == FailureMode.LOSSY_OUTPUT
            and boundary.span_block_insert_byte is not None
        ):
            at = boundary.span_block_insert_byte
            indent = boundary.insert_indent or ""
            fields = list(primitive.output_fields) or boundary.complete_output_fields
            tag = f"gigaphone:complete:{boundary.func_name}"
            line = primitive.attr_setter_template.format(
                span=boundary.span_var,
                value=boundary.complete_value_expr,
                fields="&" + repr(fields),
            )
            return CodeEdit(
                boundary.path,
                [import_hunk, Hunk(at, at, f"{indent}{line}  // {tag}\n", tag)],
                f"record complete output for `{boundary.func_name}` ({primitive.backend_id})",
            )
        return None


# --- module-level helpers -------------------------------------------------------------
def _registry_entries(source: str) -> list[tuple[str, str]]:
    """A `match <scrutinee> { "tool" => tool_fn(..), .. }` dispatch -> [(key, fn_ident)]."""
    entries: list[tuple[str, str]] = []
    for m in re.finditer(r"\bmatch\s+[A-Za-z_][\w.]*\s*\{", source):
        brace = source.index("{", m.end() - 1)
        close = _match(source, brace, "{", "}")
        if close == -1:
            continue
        inner = source[brace + 1 : close]
        for arm in re.finditer(r'"([^"]+)"\s*=>\s*([A-Za-z_]\w*)\s*\(', inner):
            entries.append((arm.group(1), arm.group(2)))
    return entries


def _targets_module(match_call: str, module: str) -> bool:
    return match_call == module or match_call.startswith(module + ".")


def _already_fixed(source: str, func_body: str, name: str) -> bool:
    by_tag = (
        f"gigaphone:trace:{name}",
        f"gigaphone:ctx:{name}",
        f"gigaphone:complete:{name}",
    )
    by_call = ("gigaphone_trace(", "gigaphone_complete(")
    return any(t in source for t in by_tag) or any(c in func_body for c in by_call)


def _has_instrument_attr(source: str, fn: _Func) -> bool:
    """A `#[instrument]` / `#[tracing::instrument]` attribute on the lines above the fn."""
    above = source[max(0, fn.header_char - 200) : fn.header_char]
    return bool(re.search(r"#\[\s*(?:tracing::)?instrument\b", above))


def _span_name(body: str) -> str | None:
    m = re.search(r"(?:info_span|debug_span|trace_span|warn_span|error_span|span)!\s*\(", body)
    if not m:
        return None
    s = re.search(r"!\s*\(\s*[^,)\"]*\"([^\"]+)\"", body[m.start() :])
    return s.group(1) if s else None


def _span_var(body: str) -> str:
    m = re.search(r"\blet\s+([A-Za-z_]\w*)\s*=\s*[^;]*?(?:info_span|debug_span|span)!", body)
    return m.group(1) if m else "span"


def _find_pool_ctor(source: str) -> tuple[int, int] | None:
    m = _POOL_CTOR_RE.search(source)
    if not m:
        return None
    paren = source.index("(", m.start())
    close = _match(source, paren, "(", ")")
    if close == -1:
        return None
    return _byte(source, m.start()), _byte(source, close + 1)


def _pool_already_wrapped(source: str) -> bool:
    return "gigaphone_propagate(" in source or "gigaphone:ctx:" in source


def _find_lossy(source: str, fn: _Func) -> tuple[str, int, str] | None:
    """A `&value[..n]` / `value.chars().take(n)` truncation inside the span block."""
    body = source[fn.body_open : fn.body_close]
    m = _SLICE_RE.search(body) or _TAKE_RE.search(body)
    if not m:
        return None
    value = m.group(1)
    abs_idx = fn.body_open + m.start()
    line_end = source.find("\n", abs_idx)
    if line_end == -1:
        line_end = fn.body_close
    indent = _indent_of(source, _line_start(source, abs_idx))
    return value, _byte(source, line_end + 1), indent


def _infer_output_fields(source: str, fn: _Func) -> list[str]:
    """Complete-result fields from a returned struct literal `Name { a, b: x, c }`."""
    body = source[fn.body_open : fn.body_close]
    matches = list(_STRUCT_LIT_RE.finditer(body))
    if not matches:
        return []
    fields = []
    for part in matches[-1].group(2).split(","):
        key = part.split(":")[0].strip()
        if re.fullmatch(r"[A-Za-z_]\w*", key):
            fields.append(key)
    return fields


def _import_insert_offset(source: str) -> int:
    """After leading `//!`/`//`/`/* */` header lines and any leading `use`/`extern crate`."""
    idx = 0
    for line in source.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith(("use ", "extern crate ", "//", "/*", "*", "*/")) or not stripped:
            idx += len(line)
        else:
            break
    return _byte(source, idx)


def _dedupe(descriptors: list[Descriptor]) -> list[Descriptor]:
    seen: dict[str, Descriptor] = {}
    for d in descriptors:
        seen.setdefault(d.match_call, d)
    return list(seen.values())
