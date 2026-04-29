"""Deriver registry.

Module-level dict mapping `<source>` (e.g. `'place_visit/v1'`) to the
deriver instance. Concrete derivers register themselves at import time
via `register(...)`; the agent's scheduler reads the registry to wire
cron-fired runs.

A Python dict, not a DB table — the set of derivers is build-time
information, not runtime state. New deriver versions ship as a code
change + a deploy, not a runtime mutation.
"""

from .base import (
    DerivedRow,
    Deriver,
    DeriverResult,
    DeterministicDeriver,
    LLMDeriver,
)

__all__ = [
    "Deriver",
    "DeterministicDeriver",
    "LLMDeriver",
    "DerivedRow",
    "DeriverResult",
    "REGISTRY",
    "register",
]

REGISTRY: dict[str, Deriver] = {}


def register(deriver: Deriver) -> Deriver:
    """Register a deriver instance under its declared SOURCE.

    Raises ValueError if SOURCE is empty or already registered. Returns
    the deriver so it can be used in module-level expressions:

        place_visit_v1 = register(PlaceVisitV1Deriver())
    """
    if not deriver.SOURCE:
        raise ValueError(
            f"{type(deriver).__name__} has no SOURCE; subclass must set it"
        )
    if deriver.SOURCE in REGISTRY:
        raise ValueError(
            f"deriver source {deriver.SOURCE!r} already registered"
        )
    REGISTRY[deriver.SOURCE] = deriver
    return deriver
