"""The engine must run with zero third-party dependencies (pure stdlib).

GigaPhone ships as a plugin launched by a bare ``python3`` (3.9+), so neither the config
I/O nor the engine import path may need PyYAML / opentelemetry / vendor SDKs.
"""

from __future__ import annotations

import builtins
import importlib

import pytest

from gigaphone import _yaml

EXAMPLE = "examples/gigaphone.boundaries.yaml"


def test_yaml_round_trips_the_config_schema():
    doc = {
        "boundaries": [
            {
                "id": "acme-gateway",
                "kind": "llm",
                "match": {"call": "our_llm.chat"},
                "input": {"arg": "messages"},
                "output": {"path": "response.text"},
                "emit": {"name": "acme.llm"},
            },
            {
                "id": "acme-exec",
                "kind": "tool_exec",
                "match": {"call": "sandbox.execute"},
                "output": {"paths": ["result.stdout", "result.stderr", "result.exit_code"]},
                "emit": {"name": "acme.exec"},
            },
        ]
    }
    assert _yaml.load(_yaml.dump(doc)) == doc


def test_yaml_parses_the_committed_example():
    with open(EXAMPLE, encoding="utf-8") as fh:
        parsed = _yaml.load(fh.read())
    ids = [b["id"] for b in parsed["boundaries"]]
    assert ids == ["acme-gateway", "acme-coderunner"]
    exec_b = parsed["boundaries"][1]
    assert exec_b["output"]["paths"] == ["result.stdout", "result.stderr", "result.exit_code"]


def test_vendored_yaml_agrees_with_pyyaml():
    """Cross-check the vendored parser against real PyYAML (a dev-only dependency)."""
    yaml = pytest.importorskip("yaml")
    with open(EXAMPLE, encoding="utf-8") as fh:
        text = fh.read()
    assert _yaml.load(text) == yaml.safe_load(text)


def test_engine_imports_without_any_third_party_module(monkeypatch):
    """Importing the CLI / config must not require PyYAML, opentelemetry, or the vendor
    SDKs — block them and confirm the engine still imports and exposes its verbs."""
    blocked = ("yaml", "opentelemetry", "opentelemetry.sdk", "braintrust", "langsmith")
    real_import = builtins.__import__

    roots = {"yaml", "opentelemetry", "braintrust", "langsmith"}

    def guarded(name, *args, **kwargs):
        if name in blocked or name.split(".")[0] in roots:
            raise ImportError(f"blocked third-party module: {name}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    import gigaphone.cli
    import gigaphone.config

    importlib.reload(gigaphone.config)
    importlib.reload(gigaphone.cli)
    assert {"discover", "plan", "fix", "verify"} <= {n for n, _ in gigaphone.cli.COMMANDS}
