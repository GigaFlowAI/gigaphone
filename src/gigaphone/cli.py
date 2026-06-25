"""GigaPhone CLI — the harness-neutral engine entrypoint.

Standalone so any harness, CI, or a human can drive it (ADR-0006). At scaffold stage
each subcommand is a documented stub that prints its contract; behaviour lands per the
milestones in ``docs/IMPLEMENTATION_PLAN.md``.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

# (command, summary) — mirrors DESIGN §5. Kept declarative so help text and the dispatch
# table never drift apart.
COMMANDS: list[tuple[str, str]] = [
    ("discover", "scan (optionally --scope) → propose boundary descriptors to confirm"),
    ("detect", "run language-pack queries for confirmed anchors → candidate boundaries"),
    ("plan", "emit plan records (+ an unresolved[] list)"),
    ("resolve", "ingest an agent-supplied resolution for an unresolved boundary"),
    ("fix", "apply codemods via the backend adapter + language pack; emit diffs"),
    ("verify", "backend-adapter verify against the live project"),
]

_NOT_IMPLEMENTED = 64  # documented stub; see docs/IMPLEMENTATION_PLAN.md


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
        if name == "discover":
            p.add_argument(
                "--scope",
                metavar="PATH",
                help="narrow discovery to these file(s)/dir (e.g. the LLM gateway) — "
                "the cheapest precise option; the recommended default",
            )
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

    # Scaffold: subcommands are documented stubs. Each milestone replaces a stub with a
    # real handler wired to the JSON contracts in docs/ and the skill references.
    print(
        f"gigaphone {args.command}: not implemented yet (scaffold). "
        f"See docs/IMPLEMENTATION_PLAN.md.",
        file=sys.stderr,
    )
    return _NOT_IMPLEMENTED


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
