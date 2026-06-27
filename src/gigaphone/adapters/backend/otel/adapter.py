"""Generic OTel / OpenInference backend adapter (DESIGN §9).

The two-tier default: targets any OTLP backend with no code change (new platform =
endpoint + headers). Supplies the vendor-specific *pieces* of each fix (which import,
which decorator/wrapper/setter); the language pack decides placement. ``verify`` reads the
exported spans — the same read path the eval platform uses (DESIGN §12, ADR-0005).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

from gigaphone.core.boundary import LLM_CONVENTION_ATTRS, BoundaryKind, FailureMode
from gigaphone.core.model import (
    Boundary,
    Expectation,
    FixPrimitive,
    LinkageResult,
    TreeVerifyResult,
    VerifyResult,
)
from gigaphone.interfaces.backend_adapter import BackendAdapter


def _render_pieces(
    lang: str, shim: str, mode: FailureMode, name: str, span_kind: str, fields
) -> dict:
    """Render a backend primitive's language-specific *pieces* (import line + call sites).

    The backend owns the semantics (which shim package, which span kind); this owns the
    per-language *syntax*. The language pack still owns placement + idempotency (DESIGN §9,
    §11). Python output is byte-identical to the pre-multi-language adapter.
    """
    if lang == "typescript":
        if mode == FailureMode.UNTRACED:
            f = ", ".join(f'"{x}"' for x in fields)
            return {
                "import_line": f'import {{ gigaphoneTrace }} from "{shim}";',
                "decorator": (
                    f'gigaphoneTrace({{ name: "{name}", kind: "{span_kind}", output: [{f}] }})'
                ),
            }
        if mode == FailureMode.OFF_CONTEXT:
            return {
                "import_line": f'import {{ gigaphonePropagate }} from "{shim}";',
                "executor_wrapper": "gigaphonePropagate",
            }
        if mode == FailureMode.LOSSY_OUTPUT:
            return {
                "import_line": f'import {{ gigaphoneComplete }} from "{shim}";',
                "attr_setter_template": "gigaphoneComplete({span}, {value}, {fields});",
            }
        raise ValueError(f"no OTel primitive for {mode} (introduce-a-boundary is advisory)")

    # python (default)
    if mode == FailureMode.UNTRACED:
        f = ", ".join(repr(x) for x in fields)
        return {
            "import_line": f"from {shim} import gigaphone_trace",
            "decorator": f'gigaphone_trace(name="{name}", kind="{span_kind}", output=[{f}])',
        }
    if mode == FailureMode.OFF_CONTEXT:
        return {
            "import_line": f"from {shim} import gigaphone_propagate",
            "executor_wrapper": "gigaphone_propagate",
        }
    if mode == FailureMode.LOSSY_OUTPUT:
        return {
            "import_line": f"from {shim} import gigaphone_complete",
            "attr_setter_template": "gigaphone_complete({span}, {value}, fields={fields})",
        }
    raise ValueError(f"no OTel primitive for {mode} (introduce-a-boundary is advisory)")


class OtelAdapter(BackendAdapter):
    id = "otel"
    # The runtime shim each emitted fix imports, per language. Native adapters override only
    # this mapping (+ id/detection/init) and inherit the whole fix-routing surface.
    shim_packages = {"python": "gigaphone.runtime.otel", "typescript": "@gigaphone/otel"}

    # --- detection / config ---------------------------------------------------------
    def detect_presence(self, repo) -> bool:
        root = str(repo)
        for dirpath, _dirs, files in os.walk(root):
            if any(f.endswith(".py") for f in files):
                for f in files:
                    if not f.endswith(".py"):
                        continue
                    try:
                        with open(os.path.join(dirpath, f), encoding="utf-8") as fh:
                            text = fh.read()
                    except OSError:
                        continue
                    if "opentelemetry" in text or "openinference" in text:
                        return True
        return False

    def config_schema(self) -> dict:
        return {
            "endpoint": "OTLP endpoint URL",
            "headers": "OTLP headers (auth)",
            "service_name": "logical service name",
        }

    def init_snippet(self, config: dict) -> str:
        ep = config.get("endpoint", "${OTEL_EXPORTER_OTLP_ENDPOINT}")
        return (
            "from opentelemetry import trace\n"
            "from opentelemetry.sdk.trace import TracerProvider\n"
            "from opentelemetry.sdk.trace.export import BatchSpanProcessor\n"
            "from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter\n"
            "provider = TracerProvider()\n"
            f"provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint={ep!r})))\n"
            "trace.set_tracer_provider(provider)\n"
        )

    # --- fix primitives (one per failure mode) --------------------------------------
    def primitive_for(
        self, boundary: Boundary, mode: FailureMode, lang: str = "python"
    ) -> FixPrimitive:
        if boundary.kind == BoundaryKind.LLM:
            return self._llm_primitive(boundary, mode, lang)
        shim = self.shim_packages.get(lang, self.shim_packages["python"])
        name = boundary.emit_name or f"{boundary.provider_or_framework}.{boundary.func_name}"
        span_kind = "agent" if boundary.kind == BoundaryKind.AGENT_CALL else "tool"
        if mode == FailureMode.UNTRACED:
            r = _render_pieces(lang, shim, mode, name, span_kind, boundary.complete_output_fields)
            return FixPrimitive(
                failure_mode=mode,
                backend_id=self.id,
                import_line=r["import_line"],
                emit_name=name,
                output_fields=tuple(boundary.complete_output_fields),
                decorator=r["decorator"],
            )
        if mode == FailureMode.OFF_CONTEXT:
            r = _render_pieces(lang, shim, mode, name, span_kind, boundary.complete_output_fields)
            return FixPrimitive(
                failure_mode=mode,
                backend_id=self.id,
                import_line=r["import_line"],
                emit_name=boundary.existing_span_name or boundary.func_name,
                executor_wrapper=r["executor_wrapper"],
            )
        if mode == FailureMode.LOSSY_OUTPUT:
            r = _render_pieces(lang, shim, mode, name, span_kind, boundary.complete_output_fields)
            return FixPrimitive(
                failure_mode=mode,
                backend_id=self.id,
                import_line=r["import_line"],
                emit_name=boundary.existing_span_name or boundary.func_name,
                output_fields=tuple(boundary.complete_output_fields),
                attr_setter_template=r["attr_setter_template"],
            )
        raise ValueError(f"no OTel primitive for {mode} (introduce-a-boundary is advisory)")

    def _llm_primitive(
        self, boundary: Boundary, mode: FailureMode, lang: str = "python"
    ) -> FixPrimitive:
        """LLM-boundary fixes (Approach A, Path 2 hand-rolled). The hand-rolled gateway gets
        a gigaphone llm span recording the OpenInference convention; off_context reuses the
        executor-wrapper. Path 1 (recognized SDK) enables the provider's instrumentor via
        ``enable_llm_instrumentation`` at the init site instead of editing the call."""
        shim = self.shim_packages.get(lang, self.shim_packages["python"])
        name = (
            boundary.existing_span_name
            or boundary.emit_name
            or f"{boundary.provider_or_framework}.llm"
        )
        if mode == FailureMode.LOSSY_OUTPUT:
            return FixPrimitive(
                failure_mode=mode,
                backend_id=self.id,
                import_line=f"from {shim} import gigaphone_llm_complete",
                emit_name=name,
            )
        if mode == FailureMode.UNTRACED:
            attr = boundary.llm_model_attr
            arg = boundary.llm_messages_arg or "messages"
            emit = boundary.emit_name or f"{boundary.provider_or_framework}.llm"
            decorator = (
                f'gigaphone_llm_trace(name="{emit}", model_attr={attr!r}, messages_arg={arg!r})'
            )
            return FixPrimitive(
                failure_mode=mode,
                backend_id=self.id,
                import_line=f"from {shim} import gigaphone_llm_trace",
                emit_name=emit,
                decorator=decorator,
            )
        if mode == FailureMode.OFF_CONTEXT:
            return FixPrimitive(
                failure_mode=mode,
                backend_id=self.id,
                import_line=f"from {shim} import gigaphone_propagate",
                emit_name=name,
                executor_wrapper="gigaphone_propagate",
            )
        raise ValueError(f"no OTel LLM primitive for {mode}")

    def enable_llm_instrumentation(self, provider: str) -> tuple[str, str]:
        """Path 1: the import + init lines that enable a recognized provider's OpenInference
        instrumentor (emits the full LLM convention for free). Placed at the telemetry-init
        site by ``fix``. Returns (import_line, init_line)."""
        cls = {
            "openai": "OpenAIInstrumentor",
            "anthropic": "AnthropicInstrumentor",
            "langchain": "LangChainInstrumentor",
        }.get(provider)
        if cls is None:
            raise ValueError(f"no OpenInference instrumentor known for provider {provider!r}")
        module = f"openinference.instrumentation.{provider}"
        return (f"from {module} import {cls}", f"{cls}().instrument()")

    def expectation_for(self, boundary: Boundary) -> Expectation:
        """What this boundary's span must look like post-fix — derivable whether or not the
        boundary still carries a failure mode, so ``verify`` is stateless (ADR-0005)."""
        if boundary.kind == BoundaryKind.LLM:
            span_name = boundary.existing_span_name or boundary.emit_name or boundary.func_name
            attrs = list(LLM_CONVENTION_ATTRS) if boundary.requires_llm_convention else []
            return Expectation(
                boundary.func_name, span_name, require_nested=True, require_attrs=attrs, kind="llm"
            )
        tool = boundary.tools_covered[0] if boundary.tools_covered else boundary.func_name
        span_name = boundary.existing_span_name or boundary.emit_name or boundary.func_name
        if boundary.kind == BoundaryKind.AGENT_CALL:
            # native body-wrap: assert the dispatch span is present + nested under the agent
            # root; a streamed dispatch has no single return to assert completeness on.
            return Expectation(tool, span_name, require_nested=True, require_attrs=[])
        attrs = (
            [f"gigaphone.output.{f}" for f in boundary.complete_output_fields]
            if boundary.requires_complete_attrs
            else []
        )
        return Expectation(tool, span_name, require_nested=True, require_attrs=attrs)

    # fix-primitive methods required by the interface (delegate to primitive_for/emitter) ---
    def trace_boundary(self, node, kind):  # pragma: no cover - covered via primitive_for
        return self.primitive_for(node, FailureMode.UNTRACED)

    def restore_context(self):  # pragma: no cover
        return "gigaphone_propagate"

    def map_output(self, output_spec):  # pragma: no cover
        return output_spec

    def enable_framework(self, framework):  # pragma: no cover
        return None

    # --- verification (the read path the eval platform uses) ------------------------
    def verify(self, project, run) -> list[VerifyResult]:
        """project = {"repo": dir, "module": "app.run_representative", "root": dir}
        run = list[Expectation]. Runs the representative path, captures spans, checks each
        expected tool span is present, nested under the agent root, and complete."""
        repo = project["repo"]
        module = project.get("module", "app.run_representative")
        root = project.get("root", repo)
        lang = project.get("lang", "python")
        entry = project.get("entry")
        expectations: list[Expectation] = run

        spans = _run_and_capture(repo, root, module, lang, entry)
        by_id = {s["span_id"]: s for s in spans}
        roots = [s for s in spans if s.get("parent_id") is None]
        agent = next((s for s in roots if s["name"] == "agent"), roots[0] if roots else None)
        agent_id = agent["span_id"] if agent else None

        results: list[VerifyResult] = []
        for exp in expectations:
            matches = [s for s in spans if s["name"] == exp.span_name]
            if not matches:
                results.append(VerifyResult(exp.tool, False, False, False, "span not found"))
                continue
            span = matches[-1]
            results.append(_evaluate([span], exp, agent_id, by_id))
        return results

    def verify_tree(self, project, run) -> TreeVerifyResult:
        """End-to-end proof of one coherent trace tree: a single root agent span with every
        LLM and tool span (ALL occurrences) nested + complete, and each requested tool
        causally linked to its span (this feature; DESIGN §12)."""
        repo = project["repo"]
        module = project.get("module", "app.run_representative")
        root = project.get("root", repo)
        lang = project.get("lang", "python")
        entry = project.get("entry")
        expectations: list[Expectation] = run

        spans = _run_and_capture(repo, root, module, lang, entry)
        by_id = {s["span_id"]: s for s in spans}
        roots = [s for s in spans if s.get("parent_id") is None]
        single_root = len(roots) == 1
        agent = next((s for s in roots if s["name"] == "agent"), roots[0] if roots else None)
        agent_id = agent["span_id"] if agent else None
        root_name = agent["name"] if agent else None

        # every occurrence of each expected span must be nested + complete (e.g. all llm turns)
        results = [
            _evaluate([s for s in spans if s["name"] == exp.span_name], exp, agent_id, by_id)
            for exp in expectations
        ]

        # causal linkage: a tool the model requested (recorded on some llm span's tool_calls)
        # must have a nested + complete span in this tree.
        tool_calls_text = " ".join(
            str(s.get("attributes", {}).get("llm.tool_calls", "")) for s in spans
        )
        ok_tools = {r.tool for r in results if r.ok and r.kind != "llm"}
        linkage = [
            LinkageResult(exp.tool, (exp.tool in tool_calls_text) and (exp.tool in ok_tools))
            for exp in expectations
            if exp.kind != "llm"
        ]
        return TreeVerifyResult(
            single_root=single_root,
            root_span_name=root_name,
            results=results,
            linkage=linkage,
        )


def _evaluate(matches: list, exp: Expectation, agent_id, by_id: dict) -> VerifyResult:
    """Evaluate an expectation against all matching spans: present, every match nested, and
    every required attr present on every match."""
    if not matches:
        return VerifyResult(exp.tool, False, False, False, "span not found", kind=exp.kind)
    nested = all((not exp.require_nested) or _is_descendant(s, agent_id, by_id) for s in matches)
    missing = sorted(
        {a for s in matches for a in exp.require_attrs if a not in s.get("attributes", {})}
    )
    complete = not missing
    problems = []
    if not nested:
        problems.append("orphan")
    if missing:
        problems.append("missing " + ",".join(missing))
    return VerifyResult(exp.tool, True, nested, complete, " ".join(problems), kind=exp.kind)


def _is_descendant(span: dict, ancestor_id, by_id: dict) -> bool:
    seen = set()
    cur = span
    while cur is not None and cur["span_id"] not in seen:
        seen.add(cur["span_id"])
        pid = cur.get("parent_id")
        if pid == ancestor_id:
            return True
        cur = by_id.get(pid)
    return False


def _run_and_capture(
    repo: str, root: str, module: str, lang: str = "python", entry: str | None = None
) -> list[dict]:
    """Run the representative path and read back the spans it exported as JSONL.

    Language-neutral on the read side (the shim emits the same span shape everywhere); only
    the *launch* differs — ``python -m <module>`` for Python, ``node <entry>`` for TypeScript
    (Node resolves ``@gigaphone/*`` from the project's own ``node_modules``).
    """
    fd, span_file = tempfile.mkstemp(suffix=".jsonl", prefix="gigaphone_spans_")
    os.close(fd)
    open(span_file, "w").close()
    env = dict(os.environ)
    env["GIGAPHONE_SPAN_FILE"] = span_file
    if lang == "typescript":
        argv = ["node", entry or "run_representative.mjs"]
    else:
        env["PYTHONPATH"] = os.pathsep.join(filter(None, [root, env.get("PYTHONPATH", "")]))
        argv = [sys.executable, "-m", module]
    proc = subprocess.run(
        argv,
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"representative path failed:\n{proc.stderr}")
    spans = []
    with open(span_file, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                spans.append(json.loads(line))
    os.unlink(span_file)
    return spans
