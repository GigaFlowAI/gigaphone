"""Generate (or verify) the committed harness plugin files from the single manifest source.

    uv run python scripts/build_plugins.py            # write the generated files
    uv run python scripts/build_plugins.py --check     # CI/release gate: exit 1 if stale

Writes the Claude Code plugin (the repo root is the plugin + a single-plugin marketplace)
and the Codex package, plus a bundled copy of the shared SKILL.md so the Claude Code plugin
is self-contained. The rendering + freshness logic lives in
``gigaphone.adapters.harness.packaging`` (importable + tested); this is a thin CLI over it.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from gigaphone.adapters.harness import packaging  # noqa: E402


def main(argv: list[str]) -> int:
    if "--check" in argv:
        stale = packaging.check_committed(str(ROOT))
        if stale:
            print("stale plugin files (run `python scripts/build_plugins.py` and commit):")
            for rel in stale:
                print(f"  - {rel}")
            return 1
        print("plugin files are up to date")
        return 0

    written = packaging.write(str(ROOT))
    print("built: " + ", ".join(written) + ", skills/gigaphone/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
