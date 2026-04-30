"""`movement/v1` deriver — first-class motion segments.

A movement is a contiguous run of GPS readings NOT inside any place_visit.
Inspired by trackintel's separation of staypoints (stays) and triplegs
(motion): the motion entity is independent of bracketing visits, with
`from_visit_id` and `to_visit_id` exposed as NULLABLE hints.

This is the structural fix for the failure mode where `travel_leg/v1`
required two bracketing `place_visit/v1` rows and silently dropped real
walks that didn't qualify on both ends — e.g. a 27-minute walk that
ended with a sub-threshold 3-minute stop. Under `travel_leg/v1` such
walks emitted nothing. Under `movement/v1` they emit a row with
`to_visit_id = NULL` (and the dashboard renders them honestly).

Pipeline:

    fetch place_visit/v1 overlapping [window - lookback, end)
    fetch phone.location.reading in same window, accuracy ≤ cap
    label each reading: in-visit (falls inside a place_visit span) or in-motion
    group consecutive in-motion readings into runs, breaking on
        gaps > gap_threshold_min (no readings ≥ N min implies "we lost
        the trace" — different motion segment)
    for each run with ≥ min_readings_for_movement points:
        prev_visit  = visit whose end_ts is the most recent before run.start
        next_visit  = visit whose start_ts is the earliest after run.end
        activity    = phone.activity.state vote over run span
        path        = _smooth_path(...)  (reuse travel_leg's smoother)
        distance_m  = haversine sum
        emit DerivedRow(source='movement/v1', ...)

Deterministic id is `uuid5(NAMESPACE_URL,
"movement/v1:{first_reading_id}:{last_reading_id}")`. Reading ids are
canonical event ids and don't drift across replays. If a run's
boundary shifts (e.g. a place_visit gets extended on a later tick,
absorbing a previously-in-motion reading), the new run has different
endpoint readings → different id, which is the correct behavior.

Coexists with `travel_leg/v1` during transition. The dashboard's read
path will eventually swap; for now both emit. travel_leg consumers
keep working unchanged.
"""

from __future__ import annotations

import logging
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, UUID, uuid5

from . import register
from .base import DerivedRow, DeterministicDeriver, IdempotencyMode
from .travel_leg import (
    _ACTIVITY_WIRE_TO_KIND,
    _path_distance_m,
    _smooth_path,
)

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers.movement")

SOURCE = "movement/v1"


@dataclass(frozen=True)
class _VisitRef:
    """The slice of a place_visit row this deriver needs."""

    id: UUID
    start_ts: datetime
    end_ts: datetime


@dataclass(frozen=True)
class _Reading:
    """A GPS positionfix from `phone.location.reading`."""

    id: str
    ts: datetime
    lng: float
    lat: float


class MovementV1Deriver(DeterministicDeriver):
    """Emits movement rows for in-motion runs of GPS readings.

    Knobs:
      - `path_accuracy_max_m`: drop readings worse than this from the
        path. 75m matches `travel_leg/v1` so the same fixes feed both.
      - `gap_threshold_min`: max gap between consecutive in-motion
        readings in a single movement. Larger gaps split into separate
        runs — modeled on trackintel's `gap_threshold` (15 min default).
      - `min_readings_for_movement`: don't emit a row for a single
        ping. ≥ 2 produces a real path.
      - `min_distance_m`: don't emit micro-movements (a couple of GPS
        wobbles outside any visit). 30m is a couple of building widths;
        anything shorter is noise.
      - `fetch_lookback_hours`: positionfix fetch lookback so a run that
        started before the window's edge is still complete.
    """

    SOURCE = SOURCE
    INPUTS = ("phone.location.reading", "phone.activity.state", "place_visit/v1")
    IDEMPOTENCY_MODE = IdempotencyMode.OVERLAP_REPLACE

    path_accuracy_max_m: float = 75.0
    gap_threshold_min: float = 15.0
    min_readings_for_movement: int = 2
    min_distance_m: float = 30.0
    fetch_lookback_hours: float = 8.0

    def compute(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> tuple[list[DerivedRow], dict[str, Any]]:
        fetch_start = start - timedelta(hours=self.fetch_lookback_hours)
        visits = self._fetch_visits(conn, fetch_start, end)
        readings = self._fetch_readings(conn, fetch_start, end)

        rows: list[DerivedRow] = []
        metrics: dict[str, Any] = {
            "readings_total": len(readings),
            "visits_total": len(visits),
            "runs_detected": 0,
            "runs_skipped_too_short": 0,
            "runs_skipped_too_brief_distance": 0,
            "runs_skipped_pre_window": 0,
            "movements_emitted": 0,
            "activity_unknown_movements": 0,
        }

        runs = _segment_motion_runs(
            readings,
            visits,
            gap_threshold=timedelta(minutes=self.gap_threshold_min),
        )
        metrics["runs_detected"] = len(runs)

        for run, prev_visit, next_visit in runs:
            if len(run) < self.min_readings_for_movement:
                metrics["runs_skipped_too_short"] += 1
                continue

            run_start = run[0].ts
            run_end = run[-1].ts

            # OVERLAP_REPLACE: skip runs whose entire span is in lookback.
            if run_end <= start:
                metrics["runs_skipped_pre_window"] += 1
                continue

            activity = self._dominant_activity(conn, run_start, run_end)
            if activity is None:
                metrics["activity_unknown_movements"] += 1
                # Default to walking — most common campus mode and the
                # safer fallback than dropping the row entirely. Mirrors
                # travel_leg.py's same-fallback. Metric tracks how often
                # we hit this so the threshold can be revisited.
                activity = "walking"
            elif activity == "still":
                # 'still' between visits = the user wasn't moving but
                # SPD didn't catch this as a stay. Movement isn't the
                # right entity for that — it's data we can't classify.
                # Skip rather than emit a phantom motion row.
                metrics["runs_skipped_too_short"] += 1
                continue

            raw_path = [[r.lng, r.lat] for r in run]
            raw_ids = [r.id for r in run]
            raw_ts = [r.ts for r in run]

            path, source_event_ids, smooth_metrics = _smooth_path(
                raw_path, raw_ids, raw_ts, activity
            )
            for k, v in smooth_metrics.items():
                metrics[k] = metrics.get(k, 0) + v

            distance_m = _path_distance_m(path)
            if distance_m < self.min_distance_m:
                metrics["runs_skipped_too_brief_distance"] += 1
                continue

            data: dict[str, Any] = {
                # NULLABLE — runs without a bracketing visit on one or
                # both sides emit with NULL FK. The dashboard render
                # path treats both fields as optional.
                "from_visit_id": (
                    str(prev_visit.id) if prev_visit is not None else None
                ),
                "to_visit_id": (
                    str(next_visit.id) if next_visit is not None else None
                ),
                "dominant_activity": activity,
                "distance_m": distance_m,
                "reading_count": len(path),
                "path": path,
            }
            provenance: dict[str, Any] = {
                "inputs": list(self.INPUTS),
                "source_event_ids": source_event_ids,
                "from_visit_id": (
                    str(prev_visit.id) if prev_visit is not None else None
                ),
                "to_visit_id": (
                    str(next_visit.id) if next_visit is not None else None
                ),
                "raw_reading_count": len(run),
            }

            rows.append(
                DerivedRow(
                    id=_deterministic_movement_id(run[0].id, run[-1].id),
                    source=self.SOURCE,
                    start_ts=run_start,
                    end_ts=run_end,
                    data=data,
                    provenance=provenance,
                )
            )
            metrics["movements_emitted"] += 1

        return rows, metrics

    # -----------------------------------------------------------------
    # DB queries
    # -----------------------------------------------------------------

    def _fetch_visits(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> list[_VisitRef]:
        """Pull `place_visit/v1` rows whose span overlaps the window."""
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, start_ts, end_ts
                  FROM public.derived_events
                 WHERE source = 'place_visit/v1'
                   AND start_ts <  %s
                   AND end_ts   >  %s
                 ORDER BY start_ts
                """,
                (end, start),
            )
            return [
                _VisitRef(id=row[0], start_ts=row[1], end_ts=row[2])
                for row in cur.fetchall()
            ]

    def _fetch_readings(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> list[_Reading]:
        """Pull GPS readings, accuracy-filtered, in chronological order."""
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id,
                       start_ts,
                       (data->>'lng')::float8,
                       (data->>'lat')::float8
                  FROM public.events
                 WHERE source = 'phone.location.reading'
                   AND start_ts >= %s
                   AND start_ts <  %s
                   AND COALESCE((data->>'accuracy_m')::float8, 9999.0) <= %s
                 ORDER BY start_ts
                """,
                (start, end, self.path_accuracy_max_m),
            )
            return [
                _Reading(
                    id=str(row[0]),
                    ts=row[1],
                    lng=float(row[2]),
                    lat=float(row[3]),
                )
                for row in cur.fetchall()
            ]

    def _dominant_activity(
        self,
        conn: "psycopg.Connection",
        run_start: datetime,
        run_end: datetime,
    ) -> str | None:
        """Most-common Android activity-state across the run, voted by
        duration. None if no usable rows overlap. Mirrors
        `travel_leg.py:_dominant_activity` exactly."""
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT data->>'state',
                       SUM(EXTRACT(EPOCH FROM (
                         LEAST(end_ts, %s) - GREATEST(start_ts, %s)
                       ))) AS overlap_s
                  FROM public.events
                 WHERE source = 'phone.activity.state'
                   AND start_ts <  %s
                   AND end_ts   >  %s
                 GROUP BY data->>'state'
                 ORDER BY overlap_s DESC
                """,
                (run_end, run_start, run_end, run_start),
            )
            for wire, _overlap in cur.fetchall():
                kind = _ACTIVITY_WIRE_TO_KIND.get(wire or "")
                if kind:
                    return kind
        return None


# ---------------------------------------------------------------------------
# Pure helpers (no DB)
# ---------------------------------------------------------------------------


def _segment_motion_runs(
    readings: list[_Reading],
    visits: list[_VisitRef],
    *,
    gap_threshold: timedelta,
) -> list[tuple[list[_Reading], _VisitRef | None, _VisitRef | None]]:
    """Group readings into in-motion runs.

    A reading is "in a visit" iff its timestamp falls within
    [visit.start_ts, visit.end_ts] for some visit. All other readings
    are in-motion. Consecutive in-motion readings form a run, with two
    rules for breaking:

      1. A reading falling inside a visit ends the current run.
      2. A gap > gap_threshold between two in-motion readings ends
         the current run (a new one starts at the next reading).
         Modeled on trackintel's `gap_threshold` (default 15 min) —
         a long no-GPS stretch isn't a continuous motion segment
         even if neither side is in a visit.

    For each emitted run, the bracketing visits are computed:
      - prev_visit = the visit whose end_ts is the most recent before
        the run's first reading. None if no prior visit exists.
      - next_visit = the visit whose start_ts is the earliest after
        the run's last reading. None if no future visit exists.

    Pure function. No DB. Deterministic.
    """
    if not readings:
        return []

    # Pre-extract visit boundaries for binary-search lookup.
    visit_starts = [v.start_ts for v in visits]
    visit_ends = [v.end_ts for v in visits]

    def _in_any_visit(ts: datetime) -> bool:
        # Find the rightmost visit whose start_ts ≤ ts; if its end_ts
        # also covers ts, the reading is in that visit. Visits are
        # sorted by start_ts. They MAY overlap (rare, e.g. a brief-exit
        # merger artifact); checking the rightmost is sufficient because
        # a later-starting visit would also cover ts if any does.
        idx = bisect_right(visit_starts, ts) - 1
        if idx < 0:
            return False
        return visit_ends[idx] >= ts

    def _prev_visit(run_start: datetime) -> _VisitRef | None:
        # Visit whose end_ts ≤ run_start AND is the most recent such.
        # A run by construction starts at a reading not in any visit,
        # so we want the visit immediately preceding that reading.
        idx = bisect_right(visit_ends, run_start) - 1
        if idx < 0:
            return None
        return visits[idx]

    def _next_visit(run_end: datetime) -> _VisitRef | None:
        # Visit whose start_ts ≥ run_end AND is the earliest such.
        idx = bisect_left(visit_starts, run_end)
        if idx >= len(visits):
            return None
        return visits[idx]

    runs: list[tuple[list[_Reading], _VisitRef | None, _VisitRef | None]] = []
    cur_run: list[_Reading] = []
    last_ts: datetime | None = None

    def _close_run() -> None:
        nonlocal cur_run
        if cur_run:
            run_start = cur_run[0].ts
            run_end = cur_run[-1].ts
            runs.append((cur_run, _prev_visit(run_start), _next_visit(run_end)))
            cur_run = []

    for r in readings:
        if _in_any_visit(r.ts):
            _close_run()
            last_ts = r.ts
            continue
        # In-motion reading. Check gap from previous in-motion reading.
        if last_ts is not None and cur_run and (r.ts - last_ts) > gap_threshold:
            # Gap too big to be the same run.
            _close_run()
        cur_run.append(r)
        last_ts = r.ts

    _close_run()
    return runs


def _deterministic_movement_id(
    first_reading_id: str,
    last_reading_id: str,
) -> UUID:
    """Stable id keyed on the bracketing event ids of the run.

    Reading ids are canonical event ids — they don't drift across
    replays. If the run boundary shifts (a previously in-motion reading
    becomes in-visit because a place_visit was extended), the run's
    endpoint reading ids change → new id, which is the correct
    behavior: the run logically changed.
    """
    key = f"movement/v1:{first_reading_id}:{last_reading_id}"
    return uuid5(NAMESPACE_URL, key)


# Auto-register on import. CLI / scheduler discover it via the registry.
register(MovementV1Deriver())
