"""GigaPhone — trace-coverage instrumentation for AI agent codebases.

Neutral core. Carries zero built-in assumptions about a specific harness, language,
vendor, or codebase — each lives behind an interface (``gigaphone.interfaces``) or in
discovered config (``gigaphone.boundaries.yaml``). See ADR-0002.
"""

__version__ = "0.4.0"
