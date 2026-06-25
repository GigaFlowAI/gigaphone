"""GigaPhone neutral core: classifier, plan records, boundary types.

Carries none of the four axes — a plan record names no harness, language family detail,
vendor, or codebase specific beyond what discovery wrote into config (DESIGN §4).
"""

from gigaphone.core.boundary import BoundaryKind, FailureMode, Source
from gigaphone.core.plan_record import PlanRecord

__all__ = ["BoundaryKind", "FailureMode", "PlanRecord", "Source"]
