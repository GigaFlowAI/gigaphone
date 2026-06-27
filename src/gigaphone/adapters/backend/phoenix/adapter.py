"""Native Arize/Phoenix backend adapter (DESIGN §9).

Phoenix (OSS) and Arize (cloud) share the OpenInference/OTel surface and are in the OTel
family: ``phoenix.otel.register()`` / ``arize.otel.register()`` installs a global OTel
``TracerProvider`` plus the OpenInference exporter, so the OTel adapter's fix routing,
expectations, and span-file ``verify`` apply unchanged (DESIGN §9). The auto-instrumentation
path is OpenInference's instrumentors — exactly what ``OtelAdapter.enable_llm_instrumentation``
already emits — so this adapter overrides only the vendor-divergent surface: SDK detection,
config, the init snippet, and the runtime shim (``gigaphone.runtime.phoenix``).

Mapping of the three fixable failure modes to native semantics (via the shim):
- untraced     → OTel ``tool`` span around the boundary (lands in Phoenix via register()).
- off_context  → OTel context API restored across the pool/executor.
- lossy_output → complete-result attributes set on the open OTel span.
"""

from __future__ import annotations

import os

from gigaphone.adapters.backend.otel.adapter import OtelAdapter

_MARKERS = ("phoenix", "arize")


class PhoenixAdapter(OtelAdapter):
    id = "phoenix"
    # Identical placement + call sites as the OTel family; only the imported shim (per
    # language) and the backend id differ. The whole primitive_for / verify surface is
    # inherited from OtelAdapter, which reads self.shim_packages + self.id.
    shim_packages = {
        "python": "gigaphone.runtime.phoenix",
        "typescript": "@gigaphone/phoenix",
    }

    def detect_presence(self, repo) -> bool:
        return _scan_for_imports(str(repo), _MARKERS)

    def config_schema(self) -> dict:
        return {
            "endpoint": "Phoenix/Arize collector endpoint (OTLP)",
            "project": "PHOENIX_PROJECT_NAME (or Arize space/project)",
            "api_key": "PHOENIX_API_KEY / ARIZE_API_KEY",
        }

    def init_snippet(self, config: dict) -> str:
        project = config.get("project", "${PHOENIX_PROJECT_NAME}")
        return (
            "from phoenix.otel import register\n"
            f"register(project_name={project!r}, auto_instrument=True)\n"
        )


def _scan_for_imports(root: str, markers) -> bool:
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            if not f.endswith(".py"):
                continue
            try:
                with open(os.path.join(dirpath, f), encoding="utf-8") as fh:
                    text = fh.read()
            except OSError:
                continue
            if any(m in text for m in markers):
                return True
    return False
