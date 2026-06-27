"""TypeScript language pack — v1 **lexical** implementation.

This pack is a pragmatic regex/brace-scanning parser, not a full CST. It is deliberately
parserless: tree-sitter-typescript wheels are heavy and fragile to build in headless CI,
so v1 ships a lexical pack that covers the anchor catalog (gateway, tool registry,
execution sinks) and the failure-mode signatures for TS's concurrency model
(AsyncLocalStorage / worker_threads / off-ALS promises). Per ADR-0007 a pack may choose
its own parser; tree-sitter is the planned upgrade for full byte-precise localization.

It mirrors ``PythonPack``: ``discover`` proposes descriptors, ``analyze`` classifies
failure modes, ``emit_fix`` renders idempotent, byte-accurate codemods. Limits (lexical):
simple parameter lists, no string/template braces inside headers, block-bodied functions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from gigaphone.core.boundary import BoundaryKind, FailureMode, Source
from gigaphone.core.model import Boundary, CodeEdit, Descriptor, FixPrimitive, Hunk, Range
from gigaphone.interfaces.language_pack import LanguagePack

# --- built-in anchor catalog (DESIGN §7.1), TypeScript flavour -----------------------
_GATEWAY_CLASS_HINTS = ("llm", "gateway", "client", "model")
_GATEWAY_METHODS = {"chat", "complete", "completion", "generate", "create", "invoke"}
# span starters across OTel / OpenInference / vendor SDKs in TS
_SPAN_STARTERS = ("startSpan", "startActiveSpan", "withSpan", "start_as_current_span")
# execution sinks: trace the wrapping function, never inside (DESIGN §3)
_EXEC_SINKS = (
    "execSync",
    "exec(",
    "execFile",
    "spawn(",
    "spawnSync",
    "runInContext",
    "runInNewContext",
    "isolated-vm",
    "ivm.",
)
# context-hop signatures for TS's concurrency model (DESIGN §7.1, §10). Promises that stay
# on the AsyncLocalStorage chain are fine; these hop off it unless context is restored.
_HOP_SIGNATURES = ("new Worker", ".postMessage(", ".submit(", ".run(", "runInWorker(", "pool.")
_POOL_CTOR_RE = re.compile(r"new\s+[A-Za-z_$][\w$]*?(?:Worker|Pool)[A-Za-z_$]*\s*\(")
_TRUNCATION_RE = re.compile(r"([A-Za-z_$][\w$.]*)\s*\.\s*(?:slice|substring|substr)\s*\(\s*0\s*,")
_KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "function", "await", "do"}
_MODIFIERS = {
    "async",
    "public",
    "private",
    "protected",
    "static",
    "get",
    "set",
    "readonly",
    "override",
    "abstract",
}


@dataclass
class _Func:
    name: str
    header_char: int  # index of the line start of the function header
    body_open: int  # index of the body `{`
    body_close: int  # index of the matching `}`
    class_name: str | None
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


def _match(source: str, open_idx: int, open_ch: str, close_ch: str) -> int:
    """Index of the matching close char, skipping strings and comments. -1 if unbalanced."""
    depth = 0
    i = open_idx
    n = len(source)
    while i < n:
        c = source[i]
        if c in "'\"`":
            i = _skip_string(source, i)
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


def _skip_string(source: str, i: int) -> int:
    quote = source[i]
    i += 1
    n = len(source)
    while i < n:
        if source[i] == "\\":
            i += 2
            continue
        if source[i] == quote:
            return i + 1
        i += 1
    return n


def _body_after(source: str, paren_open: int) -> tuple[int, int] | None:
    """Given the `(` of a param list, return (body_open_idx, body_close_idx)."""
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


_FREE_FN_RE = re.compile(
    r"(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\()"
)
_ARROW_RE = re.compile(
    r"(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=][^=]*?=\s*(?:async\s*)?(\()"
)
_CLASS_RE = re.compile(r"\bclass\s+([A-Za-z_$][\w$]*)")
_METHOD_RE = re.compile(
    r"(?:public|private|protected|static|async|get|set|\s)*?([A-Za-z_$][\w$]*)\s*(\()"
)


def _scan_functions(source: str) -> list[_Func]:
    funcs: list[_Func] = []
    seen: set[int] = set()

    for rx in (_FREE_FN_RE, _ARROW_RE):
        for m in rx.finditer(source):
            paren = m.start(2)
            body = _body_after(source, paren)
            if body is None:
                continue
            funcs.append(
                _Func(
                    name=m.group(1),
                    header_char=_line_start(source, m.start()),
                    body_open=body[0],
                    body_close=body[1],
                    class_name=None,
                    indent=_indent_of(source, m.start()),
                )
            )
            seen.add(body[0])

    # class methods
    for cm in _CLASS_RE.finditer(source):
        cls = cm.group(1)
        brace = source.find("{", cm.end())
        if brace == -1:
            continue
        cls_close = _match(source, brace, "{", "}")
        if cls_close == -1:
            continue
        for mm in _METHOD_RE.finditer(source, brace + 1, cls_close):
            name = mm.group(1)
            if name in _KEYWORDS or name == cls:
                continue
            paren = mm.start(2)
            body = _body_after(source, paren)
            if body is None or body[0] in seen:
                continue
            # avoid matching call-sites: a method header sits at line start, preceded only
            # by method modifiers (async/public/...), never by `const x = obj.` etc.
            prefix = source[_line_start(source, mm.start(1)) : mm.start(1)].strip()
            if prefix and not all(tok in _MODIFIERS for tok in prefix.split()):
                continue
            funcs.append(
                _Func(
                    name=name,
                    header_char=_line_start(source, mm.start(1)),
                    body_open=body[0],
                    body_close=body[1],
                    class_name=cls,
                    indent=_indent_of(source, mm.start(1)),
                )
            )
            seen.add(body[0])
    return funcs


def _module_name(path: str) -> str:
    parts = path.replace("\\", "/").split("/")
    last = parts[-1]
    for ext in (".tsx", ".ts"):
        if last.endswith(ext):
            parts[-1] = last[: -len(ext)]
            break
    for i, p in enumerate(parts):
        if p in ("app", "src"):
            parts = parts[i:]
            break
    if parts and parts[0] == "src":
        parts = parts[1:]
    return ".".join(p for p in parts if p and p != "index")


def _proj(module: str) -> str:
    return module.split(".", 1)[0] or "app"


def _import_map(source: str) -> dict[str, str]:
    """Map imported identifier -> dotted module path (best-effort, lexical)."""
    out: dict[str, str] = {}
    rx = re.compile(r'import\s*\{([^}]*)\}\s*from\s*["\']([^"\']+)["\']')
    for m in rx.finditer(source):
        mod = _module_from_specifier(m.group(2))
        for name in m.group(1).split(","):
            name = name.strip().split(" as ")[-1].strip()
            if name:
                out[name] = f"{mod}.{name}"
    return out


def _module_from_specifier(spec: str) -> str:
    spec = spec.lstrip("./").replace("/", ".")
    for ext in (".tsx", ".ts", ".js"):
        if spec.endswith(ext):
            spec = spec[: -len(ext)]
    return spec or "app"


class TypeScriptPack(LanguagePack):
    id = "typescript"
    extensions = (".ts", ".tsx")

    # ------------------------------------------------------------- discovery (Phase A)
    def discover(self, path: str, source: str) -> list[Descriptor]:
        module = _module_name(path)
        imports = _import_map(source)
        funcs = _scan_functions(source)
        out: list[Descriptor] = []

        # 1) hand-rolled LLM gateway: a class hinting gateway/llm/client with a chat-like
        #    method taking a messages/prompt/input arg. Invisible to provider anchors.
        for cm in _CLASS_RE.finditer(source):
            cls = cm.group(1)
            if not any(h in cls.lower() for h in _GATEWAY_CLASS_HINTS):
                continue
            for fn in funcs:
                if fn.class_name == cls and fn.name in _GATEWAY_METHODS:
                    header = source[fn.header_char : fn.body_open]
                    arg = next((a for a in ("messages", "prompt", "input") if a in header), None)
                    out.append(
                        Descriptor(
                            id=f"{cls.lower()}-gateway",
                            kind=BoundaryKind.LLM,
                            match_call=f"{module}.{cls}.{fn.name}",
                            input_arg=arg,
                            emit_name=f"{_proj(module)}.llm",
                        )
                    )
                    break

        # 2) tool dispatch registry: `const TOOLS = { name: fn, ... }` (object literal).
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

        # 3) fallback: a function that wraps an execution sink, if not already a tool.
        for fn in funcs:
            if fn.name.startswith("_") or fn.class_name is not None:
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

        traced = any(s in body for s in _SPAN_STARTERS)
        hop = any(s in body for s in _HOP_SIGNATURES)

        # off_context: work offloaded across a worker/pool that creates its own span (orphan)
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
    def _locate_fn(self, source: str, boundary: Boundary) -> _Func | None:
        """Re-find the boundary's function in the current source snapshot, preferring the one
        whose header byte matches ``decorator_insert_byte`` (set during analyze) so same-named
        methods in sibling classes don't collide."""
        target = boundary.decorator_insert_byte
        for f in _scan_functions(source):
            if _byte(source, f.header_char) == target:
                return f
        return next((f for f in _scan_functions(source) if f.name == boundary.func_name), None)

    def emit_fix(self, boundary: Boundary, primitive: FixPrimitive, source: str) -> CodeEdit | None:
        import_byte = _import_insert_offset(source)
        import_hunk = Hunk(
            import_byte, import_byte, primitive.import_line + "\n", primitive.import_line
        )

        if (
            primitive.failure_mode == FailureMode.UNTRACED
            and boundary.decorator_insert_byte is not None
        ):
            # TS has no portable function decorator, so trace by wrapping the body in the
            # curried `gigaphoneTrace(opts)(fn)` higher-order call. Async-correct: the arrow
            # mirrors the boundary's own async-ness, and the shim awaits a returned promise
            # before recording output + ending the span. `this`/`super` survive (arrow).
            fn = self._locate_fn(source, boundary)
            if fn is None:
                return None
            header = source[fn.header_char : fn.body_open]
            arrow = "async () =>" if re.search(r"\basync\b", header) else "() =>"
            tag = f"gigaphone:trace:{boundary.func_name}"
            end_tag = f"{tag}:end"
            open_at = _byte(source, fn.body_open + 1)
            close_at = _byte(source, fn.body_close)
            open_text = f" return {primitive.decorator}({arrow} {{ /* {tag} */"
            close_text = f" }}); /* {end_tag} */"
            return CodeEdit(
                boundary.path,
                [
                    import_hunk,
                    Hunk(open_at, open_at, open_text, tag),
                    Hunk(close_at, close_at, close_text, end_tag),
                ],
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
                f"restore context across the worker/pool for `{boundary.func_name}` "
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
                fields=repr(fields),
            )
            return CodeEdit(
                boundary.path,
                [import_hunk, Hunk(at, at, f"{indent}{line}  // {tag}\n", tag)],
                f"record complete output for `{boundary.func_name}` ({primitive.backend_id})",
            )
        return None


# --- module-level helpers -------------------------------------------------------------
def _registry_entries(source: str) -> list[tuple[str, str]]:
    """`const TOOLS = { name: fn, ... }` -> [(name, fn_ident)]."""
    rx = re.compile(r"\b(?:const|let|var)\s+TOOLS\b[^=]*=\s*\{")
    m = rx.search(source)
    if not m:
        return []
    brace = source.find("{", m.end() - 1)
    close = _match(source, brace, "{", "}")
    if close == -1:
        return []
    inner = source[brace + 1 : close]
    entries = []
    for pair in re.finditer(r"([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)", inner):
        entries.append((pair.group(1), pair.group(2)))
    return entries


def _targets_module(match_call: str, module: str) -> bool:
    return match_call == module or match_call.startswith(module + ".")


def _already_fixed(source: str, func_body: str, name: str) -> bool:
    by_tag = (
        f"gigaphone:trace:{name}",
        f"gigaphone:ctx:{name}",
        f"gigaphone:complete:{name}",
    )
    by_call = ("gigaphoneTrace(", "gigaphoneComplete(")
    return any(t in source for t in by_tag) or any(c in func_body for c in by_call)


def _span_name(body: str) -> str | None:
    m = re.search(r"(?:startSpan|startActiveSpan|withSpan)\s*\(\s*[\"'`]([^\"'`]+)[\"'`]", body)
    return m.group(1) if m else None


def _span_var(body: str) -> str:
    m = re.search(
        r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*?(?:startSpan|startActiveSpan)", body
    )
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
    return "gigaphonePropagate(" in source or "gigaphone:ctx:" in source


def _find_lossy(source: str, fn: _Func) -> tuple[str, int, str] | None:
    """A `setAttribute(..., x.slice(0,n))`-style truncation inside the span block."""
    body = source[fn.body_open : fn.body_close]
    m = _TRUNCATION_RE.search(body)
    if not m:
        return None
    value = m.group(1)
    # insert after the line containing the truncation (still inside the span scope)
    abs_idx = fn.body_open + m.start()
    line_end = source.find("\n", abs_idx)
    if line_end == -1:
        line_end = fn.body_close
    indent = _indent_of(source, _line_start(source, abs_idx) + 0)
    return value, _byte(source, line_end + 1), indent


def _infer_output_fields(source: str, fn: _Func) -> list[str]:
    """Complete-result fields from a returned object literal `return { a, b, c }`."""
    body = source[fn.body_open : fn.body_close]
    m = re.search(r"return\s*\{([^}]*)\}", body)
    if not m:
        return []
    fields = []
    for part in m.group(1).split(","):
        key = part.split(":")[0].strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", key):
            fields.append(key)
    return fields


def _import_insert_offset(source: str) -> int:
    """After the leading block/line comment header and any leading imports, else top.

    Imports may span several physical lines (``import {\\n  a,\\n  b,\\n} from "x";``), so we
    consume a whole import statement — not just its first line — to avoid inserting *inside*
    an import block (which would corrupt it).
    """
    idx = 0
    n = len(source)
    # skip a leading block comment
    if source[:n].lstrip().startswith("/*"):
        end = source.find("*/")
        if end != -1:
            idx = source.find("\n", end)
            idx = idx + 1 if idx != -1 else end + 2

    lines = source[idx:].splitlines(keepends=True)
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped == "" or stripped.startswith(("//", "/*", "*", "*/")):
            idx += len(lines[i])
            i += 1
            continue
        if stripped.startswith("import"):
            # consume lines until this import statement terminates: a line ending in `;`
            # or a quote (ASI), or a `} from "..."` closer for a multi-line member list.
            while i < len(lines):
                idx += len(lines[i])
                tail = lines[i].rstrip()
                done = tail.endswith((";", '"', "'")) or (
                    "from " in lines[i] and ('"' in lines[i] or "'" in lines[i])
                )
                i += 1
                if done:
                    break
            continue
        break
    return _byte(source, idx)


def _dedupe(descriptors: list[Descriptor]) -> list[Descriptor]:
    seen: dict[str, Descriptor] = {}
    for d in descriptors:
        seen.setdefault(d.match_call, d)
    return list(seen.values())
