"""Python language pack (ADR-0007: stdlib ``ast``).

Carries everything Python-specific: the anchor catalog, shallow same-file def-use, the
``off_context`` signatures for Python's concurrency model, and the codemod emitters. The
engine talks only to the ``LanguagePack`` interface and never sees ``ast`` (ADR-0002).
"""

from __future__ import annotations

import ast

from gigaphone.core.boundary import BoundaryKind, FailureMode, Source
from gigaphone.core.model import Boundary, CodeEdit, Descriptor, FixPrimitive, Hunk, Range
from gigaphone.core.source import SourceMap
from gigaphone.interfaces.language_pack import LanguagePack
from gigaphone.packs.python import agent_sdks

# --- built-in anchor catalog (DESIGN §7.1) -------------------------------------------
# Execution sinks: trace the wrapping function, never inside (DESIGN §3). Matched on the
# dotted call so `os.environ` / `os.path` are NOT mistaken for `os.system`.
_EXEC_CALL_PREFIXES = ("subprocess.", "os.exec", "e2b.", "modal.", "docker.")
_EXEC_CALL_EXACT = {"os.system", "os.popen", "exec", "eval", "pyodide.runPython"}
_GATEWAY_CLASS_HINTS = ("llm", "gateway", "client", "model")
_GATEWAY_METHODS = {"chat", "complete", "completion", "generate", "create", "invoke"}
_SPAN_STARTERS = ("start_as_current_span", "start_span")
_POOL_CTORS = {"ThreadPoolExecutor", "ProcessPoolExecutor"}
# context-hop signatures: a span created behind one of these orphans unless context is
# restored (DESIGN §7.1, §10). `asyncio.create_task` copies context — intentionally absent.
_CONTEXT_HOP_CALLS = {"submit", "map", "run_in_executor", "to_thread", "apply_async"}
# provider SDK call signatures → provider tag (DESIGN §7.1; drives the instrumentor fix).
# Ordered: more specific first (endswith match).
_SDK_CALL_PROVIDERS = (
    ("chat.completions.create", "openai"),
    ("responses.create", "openai"),
    ("messages.create", "anthropic"),
    ("completions.create", "openai"),
)
# attr names that mark an llm span as already convention-complete (idempotency).
_LLM_FIX_FUNCS = ("gigaphone_llm_complete", "gigaphone_llm_trace")


def _provider_sdk_call(fn: ast.AST) -> str | None:
    """Return the provider tag if ``fn`` calls a known LLM SDK, else None."""
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            dotted = _attr_chain(n.func)
            for sig, prov in _SDK_CALL_PROVIDERS:
                if dotted.endswith(sig):
                    return prov
    return None


def _attr_chain(node: ast.AST) -> str:
    """Render a dotted name for Name/Attribute/Call chains, e.g. `a.b.c`."""
    if isinstance(node, ast.Call):
        return _attr_chain(node.func)
    if isinstance(node, ast.Attribute):
        return f"{_attr_chain(node.value)}.{node.attr}"
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _is_truncation(node: ast.AST) -> bool:
    """A subscript slice (`x[:n]`) — the model-facing truncation that loses output."""
    return isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Slice)


def _truncation_base(node: ast.AST) -> str | None:
    """The complete value behind a truncation: `str(results)[:60]` -> `results`,
    `out[:120]` -> `out`."""
    if not _is_truncation(node):
        return None
    base = node.value
    if isinstance(base, ast.Call) and base.args:
        base = base.args[0]
    return _attr_chain(base) or None


class _Functions(ast.NodeVisitor):
    """Collect FunctionDefs by name (top-level, nested, and methods)."""

    def __init__(self) -> None:
        self.by_name: dict[str, ast.FunctionDef] = {}

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        self.by_name.setdefault(node.name, node)
        self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef  # type: ignore[assignment]


class PythonPack(LanguagePack):
    id = "python"
    extensions = (".py",)

    # ----------------------------------------------------------------- discovery (Phase A)
    def discover(self, path: str, source: str) -> list[Descriptor]:
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return []
        module = _module_name(path)
        imports = _import_map(tree)
        out: list[Descriptor] = []

        # 1) hand-rolled LLM gateway: a class whose name hints "gateway/llm/client" with a
        #    chat-like method taking a messages/prompt arg. Invisible to provider anchors.
        for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
            if not any(h in cls.name.lower() for h in _GATEWAY_CLASS_HINTS):
                continue
            for m in (n for n in cls.body if isinstance(n, ast.FunctionDef)):
                if m.name in _GATEWAY_METHODS:
                    arg = next(
                        (a.arg for a in m.args.args if a.arg in ("messages", "prompt", "input")),
                        None,
                    )
                    out.append(
                        Descriptor(
                            id=f"{cls.name.lower()}-gateway",
                            kind=BoundaryKind.LLM,
                            match_call=f"{module}.{cls.name}.{m.name}",
                            input_arg=arg,
                            emit_name=f"{_proj(module)}.llm",
                            provider=_provider_sdk_call(m) or "hand_rolled",
                        )
                    )
                    break

        # 1b) provider-SDK gateway: a function/method that calls a known LLM SDK
        #     (openai/anthropic). Tagged with its provider so the fix enables that
        #     provider's OpenInference instrumentor (Approach A, Path 1).
        sdk_funcs = _Functions()
        sdk_funcs.visit(tree)
        for name, fn in sdk_funcs.by_name.items():
            provider = _provider_sdk_call(fn)
            if provider is None:
                continue
            call = f"{module}.{name}"
            if any(d.match_call == call or d.match_call.endswith(f".{name}") for d in out):
                continue
            arg = next(
                (a.arg for a in fn.args.args if a.arg in ("messages", "prompt", "input")), None
            )
            out.append(
                Descriptor(
                    id=f"{name}-gateway",
                    kind=BoundaryKind.LLM,
                    match_call=call,
                    input_arg=arg,
                    emit_name=f"{_proj(module)}.llm",
                    provider=provider,
                )
            )

        # 2) tool dispatch registry: a module-level dict {name: fn}. Resolve each fn via the
        #    file's import map to a dotted target (DESIGN §7.1 dispatch/registry anchor).
        for assign in (n for n in tree.body if isinstance(n, ast.Assign)):
            if not (isinstance(assign.value, ast.Dict) and assign.value.keys):
                continue
            if not all(isinstance(k, ast.Constant) for k in assign.value.keys):
                continue
            for k, v in zip(assign.value.keys, assign.value.values):  # noqa: B905 (py39: no strict=)
                fn = _attr_chain(v)
                if not fn or "." in fn:
                    continue
                target = imports.get(fn, f"{module}.{fn}")
                out.append(
                    Descriptor(
                        id=f"tool-{k.value}",
                        kind=BoundaryKind.TOOL_EXEC,
                        match_call=target,
                        input_arg=None,
                        emit_name=f"{_proj(module)}.{k.value}",
                    )
                )

        # 3) fallback: a function in this file that wraps an execution sink, if not already
        #    captured via a registry elsewhere.
        funcs = _Functions()
        funcs.visit(tree)
        for name, fn in funcs.by_name.items():
            if name.startswith("_"):
                continue
            if _wraps_exec_sink(fn) and not any(d.match_call.endswith(f".{name}") for d in out):
                out.append(
                    Descriptor(
                        id=f"tool-{name}",
                        kind=BoundaryKind.TOOL_EXEC,
                        match_call=f"{module}.{name}",
                        emit_name=f"{_proj(module)}.{name}",
                    )
                )

        # 4) agent-SDK dispatch (seed family B), provenance-gated. Private methods included —
        #    real dispatches (e.g. _start_app_conversation) are private.
        for name, fn in funcs.by_name.items():
            if name.startswith("__"):
                continue
            sdk = _match_direct(fn, imports) or _match_construct_carrier(fn, imports, funcs)
            if sdk is not None and not any(d.match_call.endswith(f".{name}") for d in out):
                out.append(
                    Descriptor(
                        id=f"agent-{name}",
                        kind=BoundaryKind.AGENT_CALL,
                        match_call=f"{module}.{name}",
                        input_arg=sdk.input_arg,
                        output_paths=list(sdk.output_fields),
                        emit_name=f"{_proj(module)}.subagent.{sdk.framework}",
                    )
                )
        return _dedupe(out)

    # ------------------------------------------------------------- localization (Phase B)
    def analyze(self, path: str, source: str, descriptors: list[Descriptor]) -> list[Boundary]:
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return []
        module = _module_name(path)
        smap = SourceMap(source)
        funcs = _Functions()
        funcs.visit(tree)
        boundaries: list[Boundary] = []

        for d in descriptors:
            if not _targets_module(d.match_call, module):
                continue
            func_name = d.match_call.rsplit(".", 1)[-1]
            fn = funcs.by_name.get(func_name)
            if fn is None:
                continue
            b = self._analyze_fn(d, fn, module, path, source, smap, funcs, tree)
            if b is not None:
                boundaries.append(b)
        return boundaries

    def _analyze_fn(self, d, fn, module, path, source, smap, funcs, tree) -> Boundary | None:
        rng = Range(
            path,
            smap.offset(fn.lineno, fn.col_offset),
            smap.offset(fn.end_lineno, fn.end_col_offset),
            fn.lineno,
        )
        b = Boundary(
            descriptor_id=d.id,
            kind=d.kind,
            path=path,
            func_name=fn.name,
            call=d.match_call,
            range=rng,
            complete_output_fields=list(d.output_paths),
            tools_covered=(
                [d.id.split("-", 1)[-1]]
                if d.kind in (BoundaryKind.TOOL_EXEC, BoundaryKind.AGENT_CALL)
                else []
            ),
            provider_or_framework=_proj(module),
            source=Source.SPEC,
        )
        b.emit_name = d.emit_name
        b.provider = d.provider
        b.llm_messages_arg = d.input_arg

        # complete output fields: infer from the return type if the descriptor didn't say.
        if not b.complete_output_fields and d.kind in (
            BoundaryKind.TOOL_EXEC,
            BoundaryKind.AGENT_CALL,
        ):
            b.complete_output_fields = _infer_output_fields(fn, funcs)

        # already fixed by a decorator (idempotent) -> covered, but record the span name +
        # completeness so `verify` can still build a full expectation post-fix.
        if _has_gigaphone_decorator(fn):
            b.existing_span_name = _decorator_span_name(fn) or b.emit_name
            b.requires_complete_attrs = True
            return b

        # LLM gateway: classify against the OpenInference convention (untraced / lossy_output)
        # and fix, rather than assuming it is already traced.
        if d.kind == BoundaryKind.LLM:
            return self._classify_llm(b, fn, source, smap)

        span_with = _find_span_with(fn)
        hop = _find_context_hop(fn)

        # off_context: work offloaded across a pool whose offloaded callee creates a span,
        # which orphans because the pool doesn't carry the agent context (DESIGN §10).
        # The boundary IS traced (in the worker), so this branch is terminal when the
        # callee is traced — it never falls through to `untraced`. Nesting is the whole fix,
        # so no complete-attr requirement.
        if hop is not None:
            pool_var, callee = hop
            callee_fn = funcs.by_name.get(callee)
            callee_span = _find_span_with(callee_fn) if callee_fn is not None else None
            if callee_span is not None:
                b.existing_span_name = _span_name(callee_span)
                if _pool_already_wrapped(tree, pool_var):
                    return b  # context restored -> covered (idempotent)
                ctor = _find_pool_ctor(tree, pool_var, smap)
                b.failure_modes = [FailureMode.OFF_CONTEXT]
                if ctor is not None:
                    b.pool_ctor_range = ctor
                return b

        # traced at the boundary: is the recorded output a truncation of a complete value?
        if span_with is not None:
            b.existing_span_name = _span_name(span_with)
            b.requires_complete_attrs = True
            if _calls_function(fn, "gigaphone_complete"):
                return b  # already fixed in place (idempotent)
            lossy = _find_lossy_attr(span_with, fn)
            if lossy is not None:
                span_var, complete_expr, insert_line, indent = lossy
                b.failure_modes = [FailureMode.LOSSY_OUTPUT]
                b.span_var = span_var
                b.complete_value_expr = complete_expr
                b.span_block_insert_byte = smap.line_start_offset(insert_line)
                b.insert_indent = indent
                if not b.complete_output_fields:
                    b.complete_output_fields = [complete_expr]
                return b
            return b  # traced + complete -> covered

        # no span at the boundary (offloaded work, if any, is untraced) -> untraced.
        # The fix is a decorator that records complete output, so complete attrs are required.
        b.failure_modes = [FailureMode.UNTRACED]
        b.requires_complete_attrs = True
        b.decorator_insert_byte = smap.line_start_offset(
            fn.decorator_list[0].lineno if fn.decorator_list else fn.lineno
        )
        b.insert_indent = " " * fn.col_offset
        return b

    def _classify_llm(self, b, fn, source, smap) -> Boundary:
        """Classify an LLM gateway boundary against the OpenInference convention."""
        b.requires_llm_convention = True
        # already convention-complete (idempotent) -> covered, kept for drift.
        if any(_calls_function(fn, name) for name in _LLM_FIX_FUNCS):
            span_with = _find_span_with(fn)
            b.existing_span_name = _span_name(span_with) if span_with else b.emit_name
            return b

        span_with = _find_span_with(fn)
        if span_with is not None:
            # a span exists but does not record the convention -> lossy_output: augment it.
            b.existing_span_name = _span_name(span_with)
            b.span_var = _with_span_var(span_with)
            ret = _find_return(span_with)
            if ret is not None and ret.value is not None:
                b.llm_response_expr = ast.unparse(ret.value)
                b.span_block_insert_byte = smap.line_start_offset(ret.lineno)
                b.insert_indent = " " * ret.col_offset
            else:
                last = span_with.body[-1]
                b.span_block_insert_byte = smap.line_start_offset(last.end_lineno + 1)
                b.insert_indent = " " * last.col_offset
            b.llm_model_expr = _llm_model_expr(span_with)
            if b.span_var is not None:
                b.failure_modes = [FailureMode.LOSSY_OUTPUT]
            return b

        # no span at the gateway -> untraced: wrap it with a gigaphone llm span.
        b.failure_modes = [FailureMode.UNTRACED]
        b.llm_model_attr = _llm_model_attr(fn)
        b.decorator_insert_byte = smap.line_start_offset(
            fn.decorator_list[0].lineno if fn.decorator_list else fn.lineno
        )
        b.insert_indent = " " * fn.col_offset
        return b

    # --------------------------------------------------------------------- fix emission
    def emit_fix(self, boundary: Boundary, primitive: FixPrimitive, source: str) -> CodeEdit | None:
        smap = SourceMap(source)
        import_byte = _import_insert_offset(source, smap)
        import_hunk = Hunk(
            import_byte, import_byte, primitive.import_line + "\n", primitive.import_line
        )

        # LLM lossy_output: augment the existing gateway span with the OpenInference
        # convention (input/output messages, model, usage, tool_calls).
        if (
            boundary.kind == BoundaryKind.LLM
            and primitive.failure_mode == FailureMode.LOSSY_OUTPUT
            and boundary.span_block_insert_byte is not None
            and boundary.span_var is not None
        ):
            at = boundary.span_block_insert_byte
            indent = (
                boundary.insert_indent
                if boundary.insert_indent is not None
                else _indent_at(source, at)
            )
            arg = boundary.llm_messages_arg or "messages"
            resp = boundary.llm_response_expr or "None"
            model = boundary.llm_model_expr or "None"
            tag = f"gigaphone:llm:{boundary.func_name}"
            call = (
                f"gigaphone_llm_complete({boundary.span_var}, "
                f"messages={arg}, response={resp}, model={model})"
            )
            return CodeEdit(
                boundary.path,
                [import_hunk, Hunk(at, at, f"{indent}{call}  # {tag}\n", tag)],
                f"record the OpenInference LLM convention for `{boundary.func_name}` "
                f"({primitive.backend_id})",
            )

        if (
            primitive.failure_mode == FailureMode.UNTRACED
            and boundary.decorator_insert_byte is not None
        ):
            at = boundary.decorator_insert_byte
            indent = (
                boundary.insert_indent
                if boundary.insert_indent is not None
                else _indent_at(source, at)
            )
            tag = f"gigaphone:trace:{boundary.func_name}"
            deco = f"{indent}@{primitive.decorator}  # {tag}\n"
            return CodeEdit(
                boundary.path,
                [import_hunk, Hunk(at, at, deco, tag)],
                f"trace untraced boundary `{boundary.func_name}` ({primitive.backend_id})",
            )

        if primitive.failure_mode == FailureMode.OFF_CONTEXT and boundary.pool_ctor_range:
            start, end = boundary.pool_ctor_range
            orig = source.encode("utf-8")[start:end].decode("utf-8")
            tag = f"gigaphone:ctx:{boundary.func_name}"
            new = f"{primitive.executor_wrapper}({orig})  # {tag}"
            return CodeEdit(
                boundary.path,
                [import_hunk, Hunk(start, end, new, tag)],
                f"restore context across the pool for `{boundary.func_name}` "
                f"({primitive.backend_id})",
            )

        if (
            primitive.failure_mode == FailureMode.LOSSY_OUTPUT
            and boundary.span_block_insert_byte is not None
        ):
            at = boundary.span_block_insert_byte
            indent = (
                boundary.insert_indent
                if boundary.insert_indent is not None
                else _indent_at(source, at)
            )
            fields = list(primitive.output_fields) or boundary.complete_output_fields
            tag = f"gigaphone:complete:{boundary.func_name}"
            line = primitive.attr_setter_template.format(
                span=boundary.span_var,
                value=boundary.complete_value_expr,
                fields=repr(fields),
            )
            return CodeEdit(
                boundary.path,
                [import_hunk, Hunk(at, at, f"{indent}{line}  # {tag}\n", tag)],
                f"record complete output for `{boundary.func_name}` ({primitive.backend_id})",
            )
        return None


# --- module-level helpers (kept private to the pack) ----------------------------------
def _module_name(path: str) -> str:
    import os

    parts = path.replace("\\", "/").split("/")
    parts[-1] = parts[-1][:-3] if parts[-1].endswith(".py") else parts[-1]
    # drop leading dirs up to and including a source root (the dir above the top package)
    while parts and not os.path.basename(parts[0]):
        parts.pop(0)
    # heuristic: start the module at the first "app"-like package segment if present
    for i, p in enumerate(parts):
        if p in ("app", "src"):
            parts = parts[i:]
            break
    if parts and parts[0] == "src":
        parts = parts[1:]
    return ".".join(p for p in parts if p and p != "__init__")


def _proj(module: str) -> str:
    return module.split(".", 1)[0] or "app"


def _import_map(tree: ast.Module) -> dict[str, str]:
    out: dict[str, str] = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module:
            for a in n.names:
                out[a.asname or a.name] = f"{n.module}.{a.name}"
        elif isinstance(n, ast.Import):
            for a in n.names:
                out[a.asname or a.name] = a.name
    return out


def _targets_module(match_call: str, module: str) -> bool:
    # match_call like "app.exec_tool.run_code" or "app.gateway.LLMGateway.chat"
    return match_call == module or match_call.startswith(module + ".")


def _has_gigaphone_decorator(fn: ast.FunctionDef) -> bool:
    return any("gigaphone_trace" in _attr_chain(dec) for dec in fn.decorator_list)


def _calls_function(fn: ast.FunctionDef, name: str) -> bool:
    return any(
        isinstance(n, ast.Call) and _attr_chain(n.func).split(".")[-1] == name for n in ast.walk(fn)
    )


def _decorator_span_name(fn: ast.FunctionDef) -> str | None:
    """The ``name=`` argument of a gigaphone_trace decorator, if present."""
    for dec in fn.decorator_list:
        if isinstance(dec, ast.Call) and "gigaphone_trace" in _attr_chain(dec.func):
            for kw in dec.keywords:
                if kw.arg == "name" and isinstance(kw.value, ast.Constant):
                    return kw.value.value
            if dec.args and isinstance(dec.args[0], ast.Constant):
                return dec.args[0].value
    return None


def _wraps_exec_sink(fn: ast.FunctionDef) -> bool:
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            dotted = _attr_chain(n.func)
            if dotted in _EXEC_CALL_EXACT or dotted.startswith(_EXEC_CALL_PREFIXES):
                return True
    return False


def _origin(expr, binds: dict, imports: dict):
    """Best-effort origin (dotted) of an expression, stdlib-ast only."""
    if isinstance(expr, ast.Name):
        return binds.get(expr.id) or imports.get(expr.id)
    if isinstance(expr, ast.Call):
        return _origin(expr.func, binds, imports)
    if isinstance(expr, ast.Attribute):
        base = _origin(expr.value, binds, imports)
        return f"{base}.{expr.attr}" if base else None
    return None


def _root_pkg(origin):
    return origin.split(".")[0] if origin else None


def _local_binds(fn, imports: dict) -> dict:
    """Map locally-assigned names to their origin (var = Constructor(...) / import alias)."""
    binds: dict = {}
    for n in ast.walk(fn):
        if isinstance(n, ast.Assign) and isinstance(n.value, (ast.Call, ast.Name, ast.Attribute)):
            origin = _origin(n.value, binds, imports)
            if origin:
                for t in n.targets:
                    if isinstance(t, ast.Name):
                        binds[t.id] = origin
    return binds


def _match_direct(fn, imports: dict):
    """A method call whose receiver resolves to a catalogued SDK package."""
    binds = _local_binds(fn, imports)
    for n in ast.walk(fn):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute):
            pkg = _root_pkg(_origin(n.func.value, binds, imports))
            sdk = agent_sdks.match_package_method(pkg, n.func.attr)
            if sdk is not None:
                return sdk
    return None


_CARRIER_METHODS = agent_sdks.carrier_methods()


def _has_carrier(fn) -> bool:
    for n in ast.walk(fn):
        if (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr in _CARRIER_METHODS
        ):
            return True
    return False


def _local_helper_bodies(fn, funcs):
    """fn plus one hop into any locally-defined function fn calls."""
    bodies = [fn]
    for n in ast.walk(fn):
        if isinstance(n, ast.Call):
            tail = _attr_chain(n.func).rsplit(".", 1)[-1]
            helper = funcs.by_name.get(tail)
            if helper is not None and helper is not fn:
                bodies.append(helper)
    return bodies


def _annotation_symbols(ann) -> list:
    """Best-effort construct-candidate symbol names from a return-type annotation node,
    descending through Optional/Awaitable/list/union wrappers."""
    out: list = []
    if ann is None:
        return out
    if isinstance(ann, ast.Name):
        out.append(ann.id)
    elif isinstance(ann, ast.Attribute):
        out.append(ann.attr)
    elif isinstance(ann, ast.Constant) and isinstance(ann.value, str):
        out.append(ann.value.rsplit(".", 1)[-1])  # string forward-ref
    elif isinstance(ann, ast.Subscript):
        out += _annotation_symbols(ann.value)
        out += _annotation_symbols(ann.slice)
    elif isinstance(ann, ast.BinOp):  # X | None
        out += _annotation_symbols(ann.left)
        out += _annotation_symbols(ann.right)
    elif isinstance(ann, ast.Tuple):
        for e in ann.elts:
            out += _annotation_symbols(e)
    return out


def _match_construct_carrier(fn, imports: dict, funcs):
    """fn carries an outbound call AND constructs a catalogued symbol (here or one hop),
    with the construct's origin resolving to that SDK's package."""
    if not _has_carrier(fn):
        return None
    for body in _local_helper_bodies(fn, funcs):
        binds = _local_binds(body, imports)
        # (a) literal construct call nodes
        for n in ast.walk(body):
            if isinstance(n, ast.Call):
                symbol = _attr_chain(n.func).rsplit(".", 1)[-1]
                pkg = _root_pkg(_origin(n.func, binds, imports))
                sdk = agent_sdks.match_construct(symbol, pkg)
                if sdk is not None:
                    return sdk
        # (b) return-type annotation of a one-hop helper — survives factory indirection
        for symbol in _annotation_symbols(getattr(body, "returns", None)):
            sdk = agent_sdks.match_construct(symbol, _root_pkg(imports.get(symbol)))
            if sdk is not None:
                return sdk
    return None


def _with_span_var(span_with: ast.With) -> str | None:
    for item in span_with.items:
        if item.optional_vars and isinstance(item.optional_vars, ast.Name):
            return item.optional_vars.id
    return None


def _find_return(node: ast.AST) -> ast.Return | None:
    for n in ast.walk(node):
        if isinstance(n, ast.Return):
            return n
    return None


def _llm_model_expr(span_with: ast.With) -> str | None:
    """Source expr of the model name from an existing `set_attribute("...model...", X)`."""
    for n in ast.walk(span_with):
        if (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr == "set_attribute"
            and len(n.args) >= 2
        ):
            key = n.args[0]
            if (
                isinstance(key, ast.Constant)
                and isinstance(key.value, str)
                and "model" in key.value.lower()
            ):
                return ast.unparse(n.args[1])
    return None


def _llm_model_attr(fn: ast.FunctionDef) -> str | None:
    for n in ast.walk(fn):
        if (
            isinstance(n, ast.Attribute)
            and isinstance(n.value, ast.Name)
            and n.value.id == "self"
            and n.attr in ("model", "model_name", "_model")
        ):
            return n.attr
    return None


def _find_span_with(fn: ast.FunctionDef) -> ast.With | None:
    for n in ast.walk(fn):
        if isinstance(n, ast.With):
            for item in n.items:
                if isinstance(item.context_expr, ast.Call) and any(
                    s in _attr_chain(item.context_expr.func) for s in _SPAN_STARTERS
                ):
                    return n
    return None


def _span_name(span_with: ast.With) -> str | None:
    for item in span_with.items:
        if isinstance(item.context_expr, ast.Call) and item.context_expr.args:
            arg = item.context_expr.args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                return arg.value
    return None


def _find_context_hop(fn: ast.FunctionDef) -> tuple[str, str] | None:
    """Return (pool_var, callee_name) for `pool.submit(callee, ...)`-style hops."""
    for n in ast.walk(fn):
        if (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr in _CONTEXT_HOP_CALLS
            and n.args
        ):
            pool_var = _attr_chain(n.func.value)
            callee = _attr_chain(n.args[0])
            if pool_var and callee:
                return pool_var, callee
    return None


def _assigns(node: ast.AST, var: str) -> bool:
    return isinstance(node, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id == var for t in node.targets
    )


def _find_pool_ctor(tree: ast.Module, pool_var: str, smap: SourceMap) -> tuple[int, int] | None:
    for n in ast.walk(tree):
        if not _assigns(n, pool_var):
            continue
        v = n.value
        if isinstance(v, ast.Call) and _attr_chain(v.func).split(".")[-1] in _POOL_CTORS:
            return (
                smap.offset(v.lineno, v.col_offset),
                smap.offset(v.end_lineno, v.end_col_offset),
            )
    return None


def _pool_already_wrapped(tree: ast.Module, pool_var: str) -> bool:
    for n in ast.walk(tree):
        if (
            _assigns(n, pool_var)
            and isinstance(n.value, ast.Call)
            and "propagate" in _attr_chain(n.value.func)
        ):
            return True
    return False


def _find_lossy_attr(span_with: ast.With, fn: ast.FunctionDef) -> tuple[str, str, int, str] | None:
    span_var = None
    for item in span_with.items:
        if item.optional_vars and isinstance(item.optional_vars, ast.Name):
            span_var = item.optional_vars.id
    if span_var is None:
        return None
    last_stmt = span_with.body[-1]
    indent = " " * last_stmt.col_offset  # match the with-body indentation
    for n in ast.walk(span_with):
        if (
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr == "set_attribute"
            and len(n.args) >= 2
        ):
            base = _truncation_base(n.args[1])
            if base:
                return span_var, base, last_stmt.end_lineno + 1, indent
    return None


def _infer_output_fields(fn: ast.FunctionDef, funcs: _Functions) -> list[str]:
    """Complete-result fields from the producing function's returned dataclass.

    Follows one hop to the producer: a pool hop (`fut = pool.submit(producer, ...)` then
    `return fut.result()`) or a direct `return producer(...)`.
    """
    target = fn
    hop = _find_context_hop(fn)
    if hop is not None and hop[1] in funcs.by_name:
        target = funcs.by_name[hop[1]]
    else:
        for n in ast.walk(fn):
            if isinstance(n, ast.Return) and isinstance(n.value, ast.Call):
                callee = _attr_chain(n.value.func).split(".")[-1]
                if callee in funcs.by_name:
                    target = funcs.by_name[callee]
                    break
    for n in ast.walk(target):
        if isinstance(n, ast.Return) and isinstance(n.value, ast.Call):
            kw = [k.arg for k in n.value.keywords if k.arg]
            if kw:
                return kw
    return []


def _import_insert_offset(source: str, smap: SourceMap) -> int:
    """After `from __future__` if present, else after the module docstring, else top."""
    tree = ast.parse(source)
    after_line = 1
    body = tree.body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        after_line = body[0].end_lineno + 1
    for n in body:
        if isinstance(n, ast.ImportFrom) and n.module == "__future__":
            after_line = n.end_lineno + 1
    return smap.line_start_offset(after_line)


def _indent_at(source: str, byte_offset: int) -> str:
    text = source.encode("utf-8")[:byte_offset].decode("utf-8")
    line = text.rsplit("\n", 1)[-1]
    return line[: len(line) - len(line.lstrip())]


def _dedupe(descriptors: list[Descriptor]) -> list[Descriptor]:
    seen: dict[str, Descriptor] = {}
    for d in descriptors:
        seen.setdefault(d.match_call, d)
    return list(seen.values())
