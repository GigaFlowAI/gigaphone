# Publishing the harness plugins

GigaPhone ships as two harness packages generated from a single manifest source
(`src/gigaphone/adapters/harness/manifest.py`), so there is no per-harness copy to keep in
sync (DESIGN §6, §13):

- **Claude Code** — the **repo root** is both the plugin (`.claude-plugin/plugin.json`) and a
  single-plugin marketplace (`.claude-plugin/marketplace.json`). A post-edit hook
  (`hooks/hooks.json`) and the bundled skill (`skills/gigaphone/`) auto-load. No MCP server —
  the skill drives the CLI directly.
- **Codex** — `adapters/harness/codex/` (`plugin.toml`, `openai.yaml`, `hooks.json`). The skill
  is discovered from `.agents/skills/gigaphone/` directly. Command-only hooks.

## Versioning — single source of truth

The plugin version is **derived from the package version**, never hand-edited.
`manifest.resolve_version()` reads the installed package version (falling back to parsing
`pyproject.toml` in the plugin's bare-`python3` hook context). To cut a release, bump
`version` in `pyproject.toml` once — the manifests follow on the next build.

## Build and verify

The render + freshness logic lives in `gigaphone.adapters.harness.packaging` (importable and
tested); `scripts/build_plugins.py` is a thin CLI over it.

```bash
# Regenerate the committed plugin files from the manifest source
uv run python scripts/build_plugins.py

# Release/CI gate: exit non-zero if any committed file drifted from the source
uv run python scripts/build_plugins.py --check
```

CI runs `--check` on every push/PR (`.github/workflows/ci.yml`), so a manifest edit that
wasn't rebuilt and committed fails the build instead of silently shipping stale files.

## Registering with the marketplaces

The generated artifacts are the complete package for each marketplace; registration is the
one manual, external step (it needs the publisher's credentials):

1. **Bump** `pyproject.toml` `version`, run `build_plugins.py`, commit, tag, and push.
2. **Claude Code** — add this repo as a marketplace
   (`/plugin marketplace add GigaFlowAI/gigaphone`) and install the `gigaphone` plugin from it;
   the repo root marketplace manifest is what that command reads.
3. **Codex** — publish `adapters/harness/codex/` per the Codex plugin-distribution process
   (`plugin.toml` carries the identity/version; `openai.yaml` the interface policy).

Because both manifests are generated and CI-gated, a release is: bump the version, rebuild,
commit, tag — the marketplace sources are always in lockstep with the package.
