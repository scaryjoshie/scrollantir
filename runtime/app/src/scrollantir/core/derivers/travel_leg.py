"""`travel_leg/v1` deriver.

Fills the gaps between consecutive `place_visit/v1` rows. For each
adjacent pair `(visit_prev, visit_next)`, emits one leg row with the
GPS path traced between them, the dominant Android activity-state
mode (walking/biking/driving/running/still), and the straight-line
distance.

Pipeline:

    fetch place_visit/v1 rows in [start, end)  (sorted by start_ts)
    → for each consecutive pair:
        leg span = [visit_prev.end_ts, visit_next.start_ts)
        path = phone.location.reading in span (accuracy ≤ 50)
        dominant_activity = vote phone.activity.state by duration
        distance = sum of haversine between consecutive path points
        emit DerivedRow(source='travel_leg/v1', deterministic id)

Deterministic id is `uuid5(NAMESPACE_URL,
"travel_leg/v1:{from_visit_id}:{to_visit_id}")`. Stable because
visit ids are already deterministic — replaying the deriver chain
produces identical leg ids and references.

Path is **inlined into `data`** rather than living as a sibling
column. The dashboard's fetcher (commit 8) maps the row shape into
its `TravelLeg` type which has `path` as a sibling — that's an
ergonomic surface choice on the read side; the canonical storage
keeps the leg as a single self-contained JSONB.
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, UUID, uuid5

from . import register
from .base import DerivedRow, DeterministicDeriver
from .stay_points import haversine_m

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers.travel_leg")

SOURCE = "travel_leg/v1"

# Map Android Activity Recognition wire names to scrollantir's
# TravelActivity enum (matches dashboard/.../types.ts:40-45).
_ACTIVITY_WIRE_TO_KIND: dict[str, str] = {
    "still": "still",
    "walking": "walking",
    "running": "running",
    "bicycle": "on_bicycle",
    "vehicle": "in_vehicle",
    # 'unknown' explicitly absent — falls through to None.
}


@dataclass(frozen=True)
class _VisitRef:
    """The slice of a place_visit row this deriver needs."""

    id: UUID
    start_ts: datetime
    end_ts: datetime


class TravelLegV1Deriver(DeterministicDeriver):
    """Emits leg rows for the gaps between consecutive place visits.

    Knobs:
      - `path_accuracy_max_m`: drop GPS points with worse accuracy
        from the inlined path (50m is generous; legs are about
        showing the trace, not pinning it).
      - Min-leg-length is implicit: legs with `end_ts <= start_ts`
        (back-to-back visits with no gap) are skipped.
    """

    SOURCE = SOURCE
    INPUTS = ("phone.location.reading", "phone.activity.state", "place_visit/v1")

    path_accuracy_max_m: float = 50.0

    def compute(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> tuple[list[DerivedRow], dict[str, Any]]:
        visits = self._fetch_visits(conn, start, end)

        rows: list[DerivedRow] = []
        metrics: dict[str, Any] = {
            "visit_count": len(visits),
            "legs_emitted": 0,
            "legs_skipped_no_gap": 0,
            "legs_skipped_out_of_window": 0,
            "legs_skipped_still": 0,
            "activity_unknown_legs": 0,
        }

        for prev, nxt in zip(visits, visits[1:]):
            leg_start = prev.end_ts
            leg_end = nxt.start_ts

            if leg_end <= leg_start:
                metrics["legs_skipped_no_gap"] += 1
                continue
            # leg.start_ts must lie in the deriver's window so the
            # replace_window guard doesn't reject the row.
            if leg_start < start or leg_start >= end:
                metrics["legs_skipped_out_of_window"] += 1
                continue

            path, source_event_ids = self._fetch_path(conn, leg_start, leg_end)
            activity = self._dominant_activity(conn, leg_start, leg_end)
            # 'still' isn't a transit mode — it's the artifact of a
            # gap where the user wasn't moving (probably home/asleep)
            # but no SPD-qualifying stay was detected (GPS off in a
            # basement, phone asleep, etc.). Don't emit a phantom leg
            # for it; the dashboard renders an honest gap between
            # visits instead.
            if activity == "still":
                metrics["legs_skipped_still"] += 1
                continue
            if activity is None:
                metrics["activity_unknown_legs"] += 1
                # Dashboard's TravelActivity is non-null and the map's
                # mode-keyed layer filter would render a null-mode leg
                # invisible. Default to walking — the most common
                # campus mode and a safer fallback than dropping the
                # row entirely. activity_unknown_legs metric records
                # how often we hit this so we can revisit.
                activity = "walking"
            distance_m = _path_distance_m(path)

            data: dict[str, Any] = {
                "from_visit_id": str(prev.id),
                "to_visit_id": str(nxt.id),
                "dominant_activity": activity,
                "distance_m": distance_m,
                "reading_count": len(path),
                "path": path,
            }
            provenance: dict[str, Any] = {
                "inputs": list(self.INPUTS),
                # source_event_ids includes the GPS readings that
                # built the path; activity events are weight-only and
                # not surfaced individually.
                "source_event_ids": source_event_ids,
                "from_visit_id": str(prev.id),
                "to_visit_id": str(nxt.id),
            }

            rows.append(
                DerivedRow(
                    id=_deterministic_leg_id(prev.id, nxt.id),
                    source=self.SOURCE,
                    start_ts=leg_start,
                    end_ts=leg_end,
                    data=data,
                    provenance=provenance,
                )
            )
            metrics["legs_emitted"] += 1

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
        """Pull place_visit/v1 rows in the window, ordered by start_ts."""
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, start_ts, end_ts
                  FROM public.derived_events
                 WHERE source = 'place_visit/v1'
                   AND start_ts >= %s
                   AND start_ts <  %s
                 ORDER BY start_ts
                """,
                (start, end),
            )
            return [
                _VisitRef(id=row[0], start_ts=row[1], end_ts=row[2])
                for row in cur.fetchall()
            ]

    def _fetch_path(
        self,
        conn: "psycopg.Connection",
        leg_start: datetime,
        leg_end: datetime,
    ) -> tuple[list[list[float]], list[str]]:
        """GPS readings in `[leg_start, leg_end)`, accuracy-filtered.

        Returns `(path, source_event_ids)` where `path` is an ordered
        list of `[lng, lat]` tuples (Mapbox order, matches
        `dashboard/.../types.ts:64`).
        """
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id,
                       (data->>'lng')::float8,
                       (data->>'lat')::float8
                  FROM public.events
                 WHERE source = 'phone.location.reading'
                   AND start_ts >= %s
                   AND start_ts <  %s
                   AND COALESCE((data->>'accuracy_m')::float8, 9999.0)
                       <= %s
                 ORDER BY start_ts
                """,
                (leg_start, leg_end, self.path_accuracy_max_m),
            )
            rows = cur.fetchall()
        path = [[float(r[1]), float(r[2])] for r in rows]
        ids = [str(r[0]) for r in rows]
        return path, ids

    def _dominant_activity(
        self,
        conn: "psycopg.Connection",
        leg_start: datetime,
        leg_end: datetime,
    ) -> str | None:
        """Most-common Android activity-state during the leg, mapped
        to the dashboard's TravelActivity enum. Voted by total
        duration (not count) so a single long-still spike beats a
        bunch of brief walking flicker.

        Returns None if no usable activity-state events overlap the
        leg, or if the only state(s) found are 'unknown'.
        """
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
                (leg_end, leg_start, leg_end, leg_start),
            )
            for wire, _overlap in cur.fetchall():
                kind = _ACTIVITY_WIRE_TO_KIND.get(wire or "")
                if kind:
                    return kind
        return None


def _path_distance_m(path: list[list[float]]) -> float:
    """Sum haversine distances between consecutive [lng, lat] points."""
    if len(path) < 2:
        return 0.0
    total = 0.0
    for (lng1, lat1), (lng2, lat2) in zip(path, path[1:]):
        total += haversine_m(lat1, lng1, lat2, lng2)
    return total


def _deterministic_leg_id(from_visit_id: UUID, to_visit_id: UUID) -> UUID:
    """Stable id for a travel_leg row, derived from the visit ids it
    spans. Visit ids are themselves deterministic, so the leg id is
    stable across replays."""
    key = f"travel_leg/v1:{from_visit_id}:{to_visit_id}"
    return uuid5(NAMESPACE_URL, key)


# Auto-register on import so the CLI / scheduler discover it.
register(TravelLegV1Deriver())
