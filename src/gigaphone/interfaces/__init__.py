"""The three pluggable code axes (ADR-0002).

The fourth axis — the customer's codebase shape — is *data*, not code: it lives in
``gigaphone.boundaries.yaml`` (ADR-0004), so it has no interface here.

The core depends only on these abstractions; concrete packs/adapters depend on them in
turn. The core never imports a concrete pack or adapter by name (golden principle 2).
"""

from gigaphone.interfaces.backend_adapter import BackendAdapter
from gigaphone.interfaces.harness_adapter import HarnessAdapter
from gigaphone.interfaces.language_pack import LanguagePack

__all__ = ["BackendAdapter", "HarnessAdapter", "LanguagePack"]
