"""Deriver base classes.

Mirrors the class hierarchy in `docs/data-model.md §3`:

    Deriver (abstract)
      ├── DeterministicDeriver  — pure function of inputs; no LLM
      └── LLMDeriver            — forward()/complete() around a user prompt

A deriver consumes raw events (and possibly other derived rows) over a
time window and writes one kind of `derived_events` row, idempotently.
The canonical write primitive is `agent_api.replace_derived_window`,
which atomically deletes existing rows in `(source, [start, end))`
and inserts the new ones.

`provenance` is mandatory per the schema CHECK at
`runtime/db/schemas/30_tables.sql:97-106` — every row must include
`{inputs: [...], source_event_ids: [...]}`. Audit metadata
(`p95_accuracy_m`, `match_confidence`, etc.) belongs in `provenance`,
not `data` — `data` is the user-facing payload.

v0 only ships `DeterministicDeriver`. `LLMDeriver` is here so
`sleep/v1` and other LLM-driven kinds slot in cleanly without
revisiting the framework.
"""

from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING, Any
from uuid import UUID


class IdempotencyMode(str, Enum):
    """How `DeterministicDeriver.run` reconciles its output with
    existing rows in `derived_events`.

    WINDOW_REPLACE (default): rows must have `start_ts ∈ [start, end)`.
      Old rows with start_ts in window are deleted; new rows inserted.
      Right for tick-local derivations (single-event-anchored
      derivations, point-in-time computations).

    OVERLAP_REPLACE: rows are SPANS that may have `start_ts < start`
      as long as their span overlaps the window. Old rows whose span
      overlaps are deleted; new rows inserted including possibly-
      pre-window onsets. Right for span derivers (place_visit,
      travel_leg, user_active, sleep) where overnight stays etc.
      cross window boundaries.
    """

    WINDOW_REPLACE = "window_replace"
    OVERLAP_REPLACE = "overlap_replace"

# psycopg is a runtime dep but only needed inside concrete derivers when
# they actually run. Importing it lazily keeps `from .stay_points import
# GPSReading` (and other algorithm-only modules) usable in tests
# without psycopg installed on the host.
if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers")


@dataclass(frozen=True)
class DerivedRow:
    """One `derived_events` row, ready to be sent to
    `agent_api.replace_derived_window`.

    `provenance` MUST contain `inputs` and `source_event_ids` keys per
    the table CHECK; the deriver fills them in.
    """

    id: UUID
    source: str  # 'kind/vN'; must match `^[a-z][a-z0-9_]*/v[1-9][0-9]*$`
    start_ts: datetime
    end_ts: datetime
    data: dict[str, Any]
    provenance: dict[str, Any]

    def to_jsonb(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "source": self.source,
            "start_ts": self.start_ts.isoformat(),
            "end_ts": self.end_ts.isoformat(),
            "data": self.data,
            "provenance": self.provenance,
        }


@dataclass
class DeriverResult:
    """Outcome of a single deriver run, returned to the caller for
    metrics/logging. `metrics` is a free-form dict per deriver — for
    `place_visit/v1`, expect keys like `readings_dropped`,
    `stays_detected`, `null_place_visits`, `osm_errors`."""

    rows_written: int
    metrics: dict[str, Any] = field(default_factory=dict)


class Deriver(ABC):
    """Abstract base. Subclasses set `SOURCE` and `INPUTS` and
    implement `run`. Subclasses are `DeterministicDeriver` or
    `LLMDeriver`."""

    # `kind/version` — must match the public.derived_events.source regex.
    SOURCE: str = ""

    # Raw event sources this deriver reads from `public.events`,
    # populated into each row's `provenance.inputs`.
    INPUTS: tuple[str, ...] = ()

    @abstractmethod
    def run(
        self,
        conn: psycopg.Connection,
        start: datetime,
        end: datetime,
    ) -> DeriverResult:
        """Run over `[start, end)`. Must be idempotent: a second call on
        the same window must produce the identical end-state in
        `derived_events`."""


class DeterministicDeriver(Deriver):
    """A deriver that's a pure function of its inputs — no LLM, no
    user prompts. Subclasses implement `compute`; the base class
    handles the agent_api round-trip via the appropriate idempotency
    mode."""

    # Default to tick-local replacement. Span derivers override to
    # OVERLAP_REPLACE so onset-before-window rows can be re-derived.
    IDEMPOTENCY_MODE: IdempotencyMode = IdempotencyMode.WINDOW_REPLACE

    @abstractmethod
    def compute(
        self,
        conn: psycopg.Connection,
        start: datetime,
        end: datetime,
    ) -> tuple[list[DerivedRow], dict[str, Any]]:
        """Compute the rows for this window.

        Returns `(rows, metrics)` — `rows` may be empty (the window
        gets cleared but nothing replaces it); `metrics` is free-form
        and surfaces back in `DeriverResult.metrics`.

        Under OVERLAP_REPLACE mode, rows MAY have `start_ts < start`
        as long as their span overlaps the window — the framework's
        skip-pre-window logic is no longer needed in subclasses.
        """

    def run(
        self,
        conn: psycopg.Connection,
        start: datetime,
        end: datetime,
    ) -> DeriverResult:
        log.info(
            "deriver=%s mode=%s window=[%s, %s) starting",
            self.SOURCE,
            self.IDEMPOTENCY_MODE.value,
            start.isoformat(),
            end.isoformat(),
        )
        rows, metrics = self.compute(conn, start, end)
        payload = json.dumps([r.to_jsonb() for r in rows])
        rpc = (
            "agent_api.replace_derived_overlap"
            if self.IDEMPOTENCY_MODE == IdempotencyMode.OVERLAP_REPLACE
            else "agent_api.replace_derived_window"
        )
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {rpc}(%s, %s, %s, %s::jsonb)",
                (self.SOURCE, start, end, payload),
            )
            row = cur.fetchone()
            inserted = int(row[0]) if row else 0
        conn.commit()
        log.info(
            "deriver=%s wrote %d row(s) metrics=%s",
            self.SOURCE,
            inserted,
            metrics,
        )
        return DeriverResult(rows_written=inserted, metrics=metrics)


class LLMDeriver(Deriver):
    """A deriver that runs an LLM around a user prompt-and-answer
    cycle. `forward()` proposes derivations or asks a prompt;
    `complete()` finalizes after the user answers.

    v0 stub — `sleep/v1` is the first user. Concrete LLM derivers
    typically override `run()` because the simple
    `replace_derived_window` pattern doesn't apply when there's a
    pending-prompt state to track."""

    @abstractmethod
    def forward(
        self,
        conn: psycopg.Connection,
        start: datetime,
        end: datetime,
    ) -> None:
        """First-pass over a window. May propose derived rows directly,
        or post a prompt and defer derivation to `complete()`."""

    @abstractmethod
    def complete(
        self,
        conn: psycopg.Connection,
        prompt_id: UUID,
        answer: dict[str, Any],
    ) -> None:
        """Called after a prompt has been answered. Finalizes the
        derivation using the answer."""

    def run(
        self,
        conn: psycopg.Connection,
        start: datetime,
        end: datetime,
    ) -> DeriverResult:
        raise NotImplementedError(
            f"{type(self).__name__}: LLM derivers must override run() "
            "or use forward()/complete() directly via the agent loop"
        )
