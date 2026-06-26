"""GigaPhone CLI — the harness-neutral engine entrypoint (ADR-0006).

Standalone so any harness, CI, or a human can drive it. The committed boundary config is
the source of truth between invocations (ADR-0004); commands re-derive from config + code.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence

from gigaphone import config
from gigaphone.adapters.registry import select_backend
from gigaphone.engine import detect as _detect
from gigaphone.engine import discover as _discover
from gigaphone.engine import fix as _fix
from gigaphone.engine import report as _report
from gigaphone.engine import resolve as _resolve
from gigaphone.engine import verify as _verify
from gigaphone.engine.plan import build_plan
from gigaphone.engine.review import apply_review

COMMANDS: list[tuple[str, str]] = [
    ("discover", "scan (optionally --scope) → propose boundary descriptors → write config"),
    ("detect", "run language-pack queries for confirmed anchors → candidate boundaries"),
    ("plan", "emit plan records (+ an unresolved[] list)"),
    ("resolve", "ingest an agent-supplied resolution.json for an unresolved boundary"),
    (
        "review",
        "ingest a harness review.json: reject false positives"
        " + add missed boundaries → rewrite config",
    ),
    ("fix", "apply codemods via the backend adapter + language pack; emit diffs"),
    ("verify", "backend-adapter verify against the live project"),
    ("onboard", "run discover → fix → verify and print the onboarding report"),
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gigaphone",
        description="Trace-coverage instrumentation for AI agent codebases "
        "(neutral across harness, language, vendor, codebase).",
    )
    parser.add_argument("--version", action="store_true", help="print version and exit")
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    for name, summary in COMMANDS:
        p = sub.add_parser(name, help=summary, description=summary)
        p.add_argument("--repo", default=".", help="project root (default: cwd)")
        p.add_argument("--backend", default=None, help="backend id (default: auto/otel)")
        if name in ("discover", "detect", "plan", "fix", "onboard"):
            p.add_argument("--scope", default=None, help="narrow to file(s)/dir (e.g. the gateway)")
        if name in ("verify", "onboard"):
            p.add_argument(
                "--module", default="app.run_representative", help="representative path module"
            )
        if name == "fix":
            p.add_argument(
                "--apply", action="store_true", help="write edits (default: preview diffs)"
            )
        if name == "resolve":
            p.add_argument("resolution", help="path to resolution.json")
        if name == "review":
            p.add_argument("review", help="path to review.json")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.version:
        from gigaphone import __version__

        print(f"gigaphone {__version__}")
        return 0
    if not args.command:
        build_parser().print_help()
        return 0

    handler = {
        "discover": _cmd_discover,
        "detect": _cmd_detect,
        "plan": _cmd_plan,
        "resolve": _cmd_resolve,
        "review": _cmd_review,
        "fix": _cmd_fix,
        "verify": _cmd_verify,
        "onboard": _cmd_onboard,
    }[args.command]
    try:
        return handler(args)
    except Exception as exc:  # surface the failure loudly (golden principle 8)
        print(f"gigaphone {args.command}: {exc}", file=sys.stderr)
        return 1


def _cmd_discover(args) -> int:
    descriptors = _discover.discover(args.repo, args.scope)
    path = config.save(args.repo, descriptors)
    print(f"discovered {len(descriptors)} boundary descriptor(s) → {path}")
    for d in descriptors:
        print(f"  [{d.kind.value}] {d.match_call}  → emit {d.emit_name}")
    return 0


def _cmd_detect(args) -> int:
    descriptors = config.load(args.repo)
    boundaries = _detect.detect(args.repo, descriptors, args.scope)
    for b in boundaries:
        modes = ",".join(m.value for m in b.failure_modes) or "covered"
        print(f"  {b.path}:{b.range.line} {b.func_name} [{b.kind.value}] {modes}")
    return 0


def _cmd_plan(args) -> int:
    descriptors = config.load(args.repo)
    boundaries = _detect.detect(args.repo, descriptors, args.scope)
    plan = build_plan(descriptors, boundaries)
    print(
        json.dumps(
            {
                "records": [r.to_dict() for r in plan.records],
                "unresolved": [u.__dict__ for u in plan.unresolved],
            },
            indent=2,
        )
    )
    return 0


def _cmd_resolve(args) -> int:
    with open(args.resolution, encoding="utf-8") as fh:
        resolution = json.load(fh)
    new_descriptors, unresolvable = _resolve.ingest_resolution(resolution)
    existing = {d.match_call: d for d in config.load(args.repo)}
    for d in new_descriptors:
        existing[d.match_call] = d
    config.save(args.repo, list(existing.values()))
    print(f"resolved {len(new_descriptors)} boundary(ies); {len(unresolvable)} still unresolvable")
    for uid in unresolvable:
        print(f"  ! unresolvable: {uid}", file=sys.stderr)
    return 0


def _cmd_review(args) -> int:
    with open(args.review, encoding="utf-8") as fh:
        review = json.load(fh)
    descriptors = config.load(args.repo)
    updated, summary = apply_review(descriptors, review)
    config.save(args.repo, updated)
    print(
        f"review applied: -{len(summary['rejected'])} rejected, "
        f"+{len(summary['added'])} added, {summary['kept']} kept → "
        f"{config.config_path(args.repo)}"
    )
    for rid in summary["rejected"]:
        print(f"  - rejected: {rid}")
    for call in summary["added"]:
        print(f"  + added: {call}")
    return 0


def _cmd_fix(args) -> int:
    descriptors = config.load(args.repo)
    boundaries = _detect.detect(args.repo, descriptors, args.scope)
    backend = select_backend(args.repo, args.backend)
    if args.apply:
        result = _fix.apply_fixes(args.repo, boundaries, backend)
        for diff in result.diffs.values():
            print(diff)
        n = len(result.diffs)
        print(f"applied {n} file edit(s); {result.skipped_idempotent} idempotent skip(s)")
    else:
        result = _fix.plan_fixes(args.repo, boundaries, backend)
        for e in result.edits:
            print(f"  would fix: {e.description}")
    return 0


# LLM gateway, tool, and sub-agent boundaries are verified — every call in the agent loop.
_VERIFIABLE = ("tool_exec", "agent_call", "llm")


def _cmd_verify(args) -> int:
    descriptors = config.load(args.repo)
    boundaries = _detect.detect(args.repo, descriptors, None)
    backend = select_backend(args.repo, args.backend)
    expectations = [backend.expectation_for(b) for b in boundaries if b.kind.value in _VERIFIABLE]
    tree = _verify.verify_tree(args.repo, expectations, backend, args.module)
    for v in tree.results:
        print(
            f"  {'✓' if v.ok else '✗'} [{v.kind}] {v.tool}: "
            f"{'nested + complete' if v.ok else v.detail}"
        )
    print(f"  trace tree: {'single root ✓' if tree.single_root else 'multiple roots ✗'}")
    return 0 if tree.ok else 1


def _cmd_onboard(args) -> int:
    backend = select_backend(args.repo, args.backend)
    descriptors = _discover.discover(args.repo, args.scope)
    config.save(args.repo, descriptors)
    boundaries = _detect.detect(args.repo, descriptors, args.scope)
    plan = build_plan(descriptors, boundaries)
    expectations = [backend.expectation_for(b) for b in boundaries if b.kind.value in _VERIFIABLE]
    fix_result = _fix.apply_fixes(args.repo, boundaries, backend)
    tree = _verify.verify_tree(args.repo, expectations, backend, args.module)
    print(
        _report.render(
            harness="cli",
            language="python",
            backend=backend.id,
            plan=plan,
            verify_results=tree.results,
            trace_link=None,
        )
    )
    paths = _report.write_docs(
        args.repo,
        harness="cli",
        language="python",
        backend=backend.id,
        descriptors=descriptors,
        plan=plan,
        fix_result=fix_result,
        tree=tree,
    )
    rels = [os.path.relpath(p, args.repo) for p in paths]
    print("Wrote " + " and ".join(rels))
    return 0 if (tree.results and all(r.ok for r in tree.results)) else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
