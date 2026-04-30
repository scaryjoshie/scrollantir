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
from .base import DerivedRow, DeterministicDeriver, IdempotencyMode
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

# Per-mode physical speed ceilings (m/s), used by the path
# spike-detector. An interior reading whose implied speed from
# both its previous neighbor AND its next neighbor exceeds the
# ceiling is dropped — that's the urban-multipath signature (the
# GPS bouncing between line-of-sight and reflected-satellite
# solutions, ~100-300m apart, both reporting "good" accuracy
# 15-35m, with the path immediately reversing back). Phone-side
# accuracy filters can't catch this because each fix individually
# looks fine; the tell is the impossible velocity *paired with
# an immediate return*.
#
# Ceilings are generous (≈2x typical max for the mode) so we
# don't clip honest sprints / cycling downhill / highway driving.
# Single fast-but-honest moves only fail one of the two legs and
# survive.
_SPEED_CEILING_M_S: dict[str, float] = {
    "walking": 3.0,      # brisk walk ~1.7, jog ~3.0
    "running": 5.5,      # 5.5 m/s ≈ 6:00/mile pace
    "on_bicycle": 11.0,  # 11 m/s ≈ 25 mph
    "in_vehicle": 40.0,  # 40 m/s ≈ 90 mph
}
_DEFAULT_SPEED_CEILING_M_S = 3.0  # walking, used when activity unknown

# Sub-second duplicate gate. Two phone fixes within this many
# seconds of each other carry no new information (it's the
# Fused/GPS provider firing twice for the same satellite epoch);
# the second one only adds visual jitter.
_DUP_DT_S = 0.5


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
    # Span deriver — a leg between two visits where prev.end_ts is
    # before window_start should still emit if leg_end is in window.
    IDEMPOTENCY_MODE = IdempotencyMode.OVERLAP_REPLACE

    # Loosened from 50 → 75 per location audit 2026-04-30. Median
    # post-attestation accuracy is ~20m and p95 is 51-72m; the old
    # 50m cap was dropping the high-accuracy-noise tail without
    # meaningful benefit. Especially affects readings near a
    # destination (the "leg ends 70m short of the building" issue),
    # where the phone often inflates accuracy as it transitions
    # from outdoor GPS to indoor.
    path_accuracy_max_m: float = 75.0

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
            # OVERLAP_REPLACE: leg span must overlap window. leg_end
            # must be > start_window AND leg_start must be < end_window.
            if leg_end <= start or leg_start >= end:
                metrics["legs_skipped_out_of_window"] += 1
                continue

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

            raw_path, raw_ids, raw_ts = self._fetch_path(conn, leg_start, leg_end)
            path, source_event_ids, smooth_metrics = _smooth_path(
                raw_path, raw_ids, raw_ts, activity
            )
            for k, v in smooth_metrics.items():
                metrics[k] = metrics.get(k, 0) + v
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
        """Pull place_visit/v1 rows whose span overlaps the window
        (start_ts < window_end AND end_ts > window_start). Ordered by
        start_ts. Overlap-fetch lets us bracket legs that bridge a
        visit ending pre-window with a visit starting in-window."""
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

    def _fetch_path(
        self,
        conn: "psycopg.Connection",
        leg_start: datetime,
        leg_end: datetime,
    ) -> tuple[list[list[float]], list[str], list[datetime]]:
        """GPS readings in `[leg_start, leg_end]`, accuracy-filtered.

        End is INCLUSIVE so the visit's first GPS reading (the one
        that anchored SPD on `nxt.start_ts`) lands in this leg's
        path as its final point. Per the location audit
        2026-04-30: without this, the leg path consistently ended
        ~70m short of the destination because the close-in
        boundary reading was assigned exclusively to the visit.

        Returns `(path, source_event_ids, timestamps)` where `path`
        is an ordered list of `[lng, lat]` tuples (Mapbox order,
        matches `dashboard/.../types.ts:64`). `timestamps` is the
        per-reading start_ts, exposed so the caller can run a
        velocity-based smoother.
        """
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id,
                       (data->>'lng')::float8,
                       (data->>'lat')::float8,
                       start_ts
                  FROM public.events
                 WHERE source = 'phone.location.reading'
                   AND start_ts >= %s
                   AND start_ts <= %s
                   AND COALESCE((data->>'accuracy_m')::float8, 9999.0)
                       <= %s
                 ORDER BY start_ts
                """,
                (leg_start, leg_end, self.path_accuracy_max_m),
            )
            rows = cur.fetchall()
        path = [[float(r[1]), float(r[2])] for r in rows]
        ids = [str(r[0]) for r in rows]
        timestamps = [r[3] for r in rows]
        return path, ids, timestamps

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


def _smooth_path(
    path: list[list[float]],
    ids: list[str],
    timestamps: list[datetime],
    activity: str,
) -> tuple[list[list[float]], list[str], dict[str, int]]:
    """Drop near-duplicate fixes and physically-impossible jumps.

    Per the path-jaggedness audit 2026-04-30, ~20% of points on
    walking legs are urban-multipath outliers — the GPS solution
    bouncing between the line-of-sight position and a
    reflected-satellite position 100-300m away, both reporting
    "good" accuracy 15-35m. Phone-side accuracy filters can't
    catch this; the tell is the impossible velocity. We gate by
    activity-specific speed ceilings (see `_SPEED_CEILING_M_S`).

    Two passes:
      1. Drop sub-second duplicates (consecutive fixes within
         `_DUP_DT_S` seconds) — the second carries no new info.
      2. Spike-drop. For each interior point B between
         neighbors A and C, drop B iff implied speed
         A→B AND B→C BOTH exceed the activity ceiling. This is
         the multipath-outlier signature: a point the path
         immediately reverses out of. A single fast-but-honest
         move (sprint, downhill bike) only fails one of the two
         legs and is preserved. Endpoints are always kept.

    Returns `(path, ids, metrics)`. Metrics are merged into the
    deriver's per-window metrics. Algorithm is deterministic:
    same input → same output, so OVERLAP_REPLACE replays produce
    identical rows.
    """
    metrics = {
        "smoother_dropped_dup": 0,
        "smoother_dropped_speed": 0,
    }
    if not path:
        return path, ids, metrics

    ceiling = _SPEED_CEILING_M_S.get(activity, _DEFAULT_SPEED_CEILING_M_S)

    # Pass 1: drop sub-second duplicates.
    dedup_path: list[list[float]] = []
    dedup_ids: list[str] = []
    dedup_ts: list[datetime] = []
    for pt, eid, ts in zip(path, ids, timestamps):
        if dedup_ts and (ts - dedup_ts[-1]).total_seconds() < _DUP_DT_S:
            metrics["smoother_dropped_dup"] += 1
            continue
        dedup_path.append(pt)
        dedup_ids.append(eid)
        dedup_ts.append(ts)

    # Pass 2: spike-drop. A point B is a multipath spike iff
    # both A→B and B→C imply impossible velocity for the
    # activity. Iterate until fixed-point so chains of adjacent
    # spikes (e.g. four oscillating fixes) collapse correctly.
    # Bounded by N iterations to guarantee termination.
    if len(dedup_path) < 3:
        return dedup_path, dedup_ids, metrics

    cur_path = dedup_path
    cur_ids = dedup_ids
    cur_ts = dedup_ts
    for _ in range(len(dedup_path)):
        keep = [True] * len(cur_path)
        for i in range(1, len(cur_path) - 1):
            a_pt, a_ts = cur_path[i - 1], cur_ts[i - 1]
            b_pt, b_ts = cur_path[i], cur_ts[i]
            c_pt, c_ts = cur_path[i + 1], cur_ts[i + 1]
            dt_ab = (b_ts - a_ts).total_seconds()
            dt_bc = (c_ts - b_ts).total_seconds()
            if dt_ab <= 0 or dt_bc <= 0:
                continue
            d_ab = haversine_m(a_pt[1], a_pt[0], b_pt[1], b_pt[0])
            d_bc = haversine_m(b_pt[1], b_pt[0], c_pt[1], c_pt[0])
            if d_ab / dt_ab > ceiling and d_bc / dt_bc > ceiling:
                keep[i] = False
        if all(keep):
            break
        new_path: list[list[float]] = []
        new_ids: list[str] = []
        new_ts: list[datetime] = []
        for k, p, eid, ts in zip(keep, cur_path, cur_ids, cur_ts):
            if k:
                new_path.append(p)
                new_ids.append(eid)
                new_ts.append(ts)
            else:
                metrics["smoother_dropped_speed"] += 1
        cur_path, cur_ids, cur_ts = new_path, new_ids, new_ts
        if len(cur_path) < 3:
            break

    return cur_path, cur_ids, metrics


def _deterministic_leg_id(from_visit_id: UUID, to_visit_id: UUID) -> UUID:
    """Stable id for a travel_leg row, derived from the visit ids it
    spans. Visit ids are themselves deterministic, so the leg id is
    stable across replays."""
    key = f"travel_leg/v1:{from_visit_id}:{to_visit_id}"
    return uuid5(NAMESPACE_URL, key)


# Auto-register on import so the CLI / scheduler discover it.
register(TravelLegV1Deriver())
