"""Neutral core data model (DESIGN §4, §8.4, §11).

These types are the shared vocabulary between discovery, localization, the classifier,
the language packs, and the backend adapters. They name no harness, no vendor, and no
codebase specifics beyond what discovery wrote into a ``Descriptor``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from gigaphone.core.boundary import BoundaryKind, FailureMode, Source


@dataclass(frozen=True)
class Range:
    """A byte-accurate source range (and 1-based line for human display)."""

    path: str
    byte_start: int
    byte_end: int
    line: int


@dataclass
class Descriptor:
    """A boundary descriptor — the unit discovery proposes and the committed config
    stores (DESIGN §8.4). The fourth axis (codebase shape) as *data* (ADR-0004)."""

    id: str
    kind: BoundaryKind
    match_call: str  # dotted name → per-language query (DESIGN §8.4 ``match.call``)
    input_arg: str | None = None
    output_paths: list[str] = field(default_factory=list)  # complete-result fields
    emit_name: str | None = None
    # for kind=llm: which provider the gateway uses — drives the fix path (Approach A).
    # "openai" | "anthropic" | "langchain" | "hand_rolled" | None (not an llm boundary).
    provider: str | None = None

    def to_yaml_obj(self) -> dict:
        out: dict = {"id": self.id, "kind": self.kind.value, "match": {"call": self.match_call}}
        if self.input_arg:
            out["input"] = {"arg": self.input_arg}
        if self.output_paths:
            out["output"] = (
                {"paths": list(self.output_paths)}
                if len(self.output_paths) != 1
                else {"path": self.output_paths[0]}
            )
        if self.emit_name:
            out["emit"] = {"name": self.emit_name}
        if self.provider:
            out["provider"] = self.provider
        return out

    @classmethod
    def from_yaml_obj(cls, o: dict) -> Descriptor:
        output = o.get("output", {}) or {}
        paths = output.get("paths") or ([output["path"]] if "path" in output else [])
        return cls(
            id=o["id"],
            kind=BoundaryKind(o["kind"]),
            match_call=o["match"]["call"],
            input_arg=(o.get("input") or {}).get("arg"),
            output_paths=list(paths),
            emit_name=(o.get("emit") or {}).get("name"),
            provider=o.get("provider"),
        )


@dataclass
class Boundary:
    """A concrete consumption boundary located in source, with its detected failure modes
    (DESIGN §3, §10). Produced by a language pack's ``analyze``."""

    descriptor_id: str
    kind: BoundaryKind
    path: str
    func_name: str  # the boundary function this fix targets
    call: str  # dotted name that matched
    range: Range
    failure_modes: list[FailureMode] = field(default_factory=list)
    complete_output_fields: list[str] = field(default_factory=list)
    tools_covered: list[str] = field(default_factory=list)
    provider_or_framework: str = "unknown"
    source: Source = Source.SPEC
    # placement hints the emitter needs (byte offsets), all optional:
    decorator_insert_byte: int | None = None  # line start of `def`, for decorator insert
    span_block_insert_byte: int | None = None  # end of a `with span:` body, for map_output
    pool_ctor_range: tuple[int, int] | None = (
        None  # (start,end) of a pool construction, for restore_context
    )
    span_var: str | None = None  # the span variable name in scope, for map_output
    complete_value_expr: str | None = (
        None  # expression yielding the complete result, for map_output
    )
    existing_span_name: str | None = None  # name of a span already present at the boundary
    emit_name: str | None = None  # span name to emit when tracing (untraced fix)
    insert_indent: str | None = None  # exact leading whitespace for an inserted line
    # the tool span must carry complete output attrs (true for untraced/lossy + their fixed
    # forms; false for off_context where nesting is the whole fix). Lets `verify` build a
    # full expectation from a boundary whether or not it still has a failure mode.
    requires_complete_attrs: bool = False
    # --- LLM boundary (kind=llm) extras ---
    provider: str | None = None  # openai | anthropic | langchain | hand_rolled
    # the llm span must carry the OpenInference convention (model/messages/usage/tool_calls).
    requires_llm_convention: bool = False
    llm_messages_arg: str | None = None  # name of the messages/prompt parameter
    llm_response_expr: str | None = None  # source expr of the returned response (lossy fix)
    llm_model_expr: str | None = None  # source expr yielding the model name (lossy fix)
    llm_model_attr: str | None = None  # instance attr holding the model name (untraced fix)


@dataclass(frozen=True)
class FixPrimitive:
    """A vendor-specific fix rendered language-specifically (DESIGN §9, §11).

    The backend adapter supplies the *pieces* (which import, which decorator/wrapper/setter);
    the language pack decides *placement* and idempotency. One primitive per failure mode.
    """

    failure_mode: FailureMode
    backend_id: str
    import_line: str
    emit_name: str
    output_fields: tuple[str, ...] = ()
    decorator: str | None = None  # UNTRACED: decorator expression to put above the def
    executor_wrapper: str | None = None  # OFF_CONTEXT: callable that re-parents pool workers
    attr_setter_template: str | None = None  # LOSSY_OUTPUT: "{span}.set_attribute(...)" template


@dataclass(frozen=True)
class Hunk:
    """A single byte-range edit. ``byte_end == byte_start`` means a pure insertion. ``tag``
    is the idempotency marker: if it already occurs in the file, the hunk is skipped."""

    byte_start: int
    byte_end: int
    new_text: str
    tag: str


@dataclass
class CodeEdit:
    """One logical, idempotent fix to one file — possibly several hunks (e.g. import + wrap)."""

    path: str
    hunks: list[Hunk]
    description: str


@dataclass
class Expectation:
    """What a fixed tool boundary must look like in the backend after a representative run
    (DESIGN §12). Backend-neutral: the shim records the same ``gigaphone.output.*`` keys
    regardless of vendor."""

    tool: str
    span_name: str  # post-fix span name to find in the trace
    require_nested: bool = True  # must be nested under the agent root, not an orphan
    require_attrs: list[str] = field(default_factory=list)  # complete-output attribute keys
    kind: str = "tool_exec"  # "tool_exec" | "llm" — which boundary this expectation covers


@dataclass
class VerifyResult:
    """Outcome of a single boundary's verification."""

    tool: str
    found: bool
    nested: bool
    complete: bool
    detail: str = ""
    kind: str = "tool_exec"  # "tool_exec" | "llm"

    @property
    def ok(self) -> bool:
        return self.found and self.nested and self.complete

    @property
    def kind_is_llm(self) -> bool:
        return self.kind == "llm"


@dataclass
class LinkageResult:
    """Did the model's tool request causally link to a tool span in the same tree?"""

    requested: str  # the tool the model asked for (from an llm span's tool_calls)
    linked: bool


@dataclass
class TreeVerifyResult:
    """End-to-end proof that one representative run produced a single coherent trace tree:
    a root agent span with every LLM and tool span nested + complete, and each requested
    tool causally linked to its span (this feature; DESIGN §12)."""

    single_root: bool
    root_span_name: str | None
    results: list[VerifyResult] = field(default_factory=list)  # per expectation (llm + tool)
    linkage: list[LinkageResult] = field(default_factory=list)
    detail: str = ""

    @property
    def ok(self) -> bool:
        return (
            self.single_root
            and bool(self.results)
            and all(r.ok for r in self.results)
            and all(link.linked for link in self.linkage)
        )
