"""Native Logfire backend adapter (DESIGN §9).

Logfire is in the OTel family: ``logfire.configure()`` installs a global OTel
``TracerProvider``, so the OTel adapter's fix routing, expectations, and span-file
``verify`` apply unchanged (DESIGN §9: "reuse most fix logic within a family"). Only the
vendor-divergent surface is overridden: SDK detection, config, the init snippet, and the
runtime shim the fixes import (``gigaphone.runtime.logfire``, which prefers ``logfire.span``
when the SDK is present).

Mapping of the three fixable failure modes to native semantics (via the shim):
- untraced     → ``logfire.span(name)`` around the boundary, type = tool.
- off_context  → OTel context API restored across the pool/executor (Logfire nests via it).
- lossy_output → complete-result attributes set on the open Logfire (OTel) span.
"""

from __future__ import annotations

import os

from gigaphone.adapters.backend.otel.adapter import OtelAdapter


class LogfireAdapter(OtelAdapter):
    id = "logfire"
    # Identical placement + call sites as the OTel family; only the imported shim (per
    # language) and the backend id differ. The whole primitive_for / verify surface is
    # inherited from OtelAdapter, which reads self.shim_packages + self.id.
    shim_packages = {
        "python": "gigaphone.runtime.logfire",
        "typescript": "@gigaphone/logfire",
    }

    def detect_presence(self, repo) -> bool:
        return _scan_for_import(str(repo), "logfire")

    def config_schema(self) -> dict:
        return {
            "token": "LOGFIRE_TOKEN",
            "service_name": "logical service name",
        }

    def init_snippet(self, config: dict) -> str:
        service = config.get("service_name")
        arg = f"service_name={service!r}" if service else ""
        return f"import logfire\nlogfire.configure({arg})\n"


def _scan_for_import(root: str, marker: str) -> bool:
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            if not f.endswith(".py"):
                continue
            try:
                with open(os.path.join(dirpath, f), encoding="utf-8") as fh:
                    if marker in fh.read():
                        return True
            except OSError:
                continue
    return False
