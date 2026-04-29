"""Stay-Point Detection (SPD).

Implements the sliding-window stay-point algorithm from
Zheng et al. 2009 ("Mining interesting locations and travel sequences
from GPS trajectories"), adapted for our environment with two
parameter tunes:

  - tight `accuracy_max_m` (default 30) drops indoor-drift noise
    before SPD ever sees it
  - permissive `gap_threshold_hours` (default 4) allows long indoor
    stays where GPS goes silent for hours to remain a single stay
    if the readings on either side of the gap are co-located

The accuracy filter is what implicitly handles "indoor vs outdoor" —
indoor readings tend to have bad accuracy and get dropped; outdoor
readings tend to have good accuracy and get kept. We don't write any
explicit outdoor/indoor logic.

A "stay" is a maximal run of readings within `dist_threshold_m` of
the run's anchor whose total duration is at least
`time_threshold_min`. The centroid is weighted by `1/accuracy_m` —
high-accuracy readings dominate so the centroid lands on the actual
location rather than being dragged by drift.

Used by `place_visit/v1` (commit 4) which then matches the centroid
against OSM via `core.osm.lookup_nearest_feature`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Sequence
from uuid import UUID

EARTH_RADIUS_M = 6_371_000.0


@dataclass(frozen=True)
class GPSReading:
    """One `phone.location.reading` event, normalized for SPD input."""

    id: UUID
    ts: datetime
    lat: float
    lng: float
    accuracy_m: float


@dataclass(frozen=True)
class StayPoint:
    """A run of GPS readings interpreted as the user being at one
    place. The centroid is the weighted average; `event_ids` records
    every reading that contributed (used for `provenance.
    source_event_ids` in the derived row)."""

    start_ts: datetime
    end_ts: datetime
    centroid_lat: float
    centroid_lng: float
    event_ids: tuple[UUID, ...]
    point_count: int
    p95_accuracy_m: float
    dwell_s: float


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in meters between two (lat, lng) points."""
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlng / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return EARTH_RADIUS_M * c


def extract_stay_points(
    readings: Sequence[GPSReading],
    *,
    accuracy_max_m: float = 30.0,
    dist_threshold_m: float = 40.0,
    time_threshold_min: float = 8.0,
    gap_threshold_hours: float = 4.0,
    min_points: int = 3,
) -> list[StayPoint]:
    """Run SPD over a sequence of GPS readings.

    Returns a chronologically-ordered list of stay-points. Readings
    whose `accuracy_m > accuracy_max_m` are dropped before the walk;
    readings within `dist_threshold_m` of the current run's anchor
    extend the run; a reading further than that ends the run, which
    becomes a stay only if `(end_ts - start_ts) >= time_threshold_min`
    AND the run has at least `min_points` readings.

    `min_points` is a thin-evidence guard. With gap-bridging, a 4-hour
    gap bracketed by two clean readings would otherwise produce a
    confident 4-hour stay from 2 GPS points. Requiring ≥3 points means
    the bridged-gap case still works (2 brackets + ≥1 inside) but a
    pure 2-point bridge gets rejected as too thin.

    Gap-bridging: a time gap between two readings up to
    `gap_threshold_hours` is allowed to fall *inside* a run without
    breaking it, as long as the post-gap reading is still within
    `dist_threshold_m` of the anchor. Handles long indoor stays where
    GPS gives up entirely (e.g., 4 hours in a basement with a clean
    reading at the door before and after).
    """
    if not readings:
        return []

    # Filter + sort. Both shouldn't matter in practice — events are
    # already chrono-sorted by the caller and accuracy filtering is
    # cheap — but being defensive keeps the algorithm pure in tests.
    filtered = sorted(
        (r for r in readings if r.accuracy_m <= accuracy_max_m),
        key=lambda r: r.ts,
    )
    if not filtered:
        return []

    gap_threshold_s = gap_threshold_hours * 3600.0
    time_threshold_s = time_threshold_min * 60.0

    stays: list[StayPoint] = []
    n = len(filtered)
    i = 0
    while i < n:
        anchor = filtered[i]
        j = i
        # Extend the run while the next reading is close to the anchor
        # AND the time-gap from the previous reading is within bound.
        while j + 1 < n:
            nxt = filtered[j + 1]
            gap_s = (nxt.ts - filtered[j].ts).total_seconds()
            if gap_s > gap_threshold_s:
                break
            d = haversine_m(anchor.lat, anchor.lng, nxt.lat, nxt.lng)
            if d > dist_threshold_m:
                break
            j += 1

        run = filtered[i : j + 1]
        dwell_s = (run[-1].ts - run[0].ts).total_seconds()
        if dwell_s >= time_threshold_s and len(run) >= min_points:
            stays.append(_stay_from_run(run, dwell_s))
            i = j + 1
        else:
            # Run too short to qualify as a stay (insufficient dwell
            # OR insufficient evidence) — advance one step and retry.
            # We don't skip to j+1 here since the next reading might
            # be the anchor of a real stay.
            i += 1

    return stays


def _stay_from_run(run: Sequence[GPSReading], dwell_s: float) -> StayPoint:
    """Compute the centroid + summary stats for a run of readings."""
    # Weighted centroid by 1/accuracy_m. Floor accuracy to 1m so a
    # zero or near-zero claim doesn't divide-by-zero (or dominate
    # everything else combined).
    weights = [1.0 / max(r.accuracy_m, 1.0) for r in run]
    total_w = sum(weights)
    cx_lat = sum(r.lat * w for r, w in zip(run, weights)) / total_w
    cx_lng = sum(r.lng * w for r, w in zip(run, weights)) / total_w

    # p95 accuracy: ceil-rounded percentile so a 1-reading run reports
    # that reading's accuracy (not 0).
    sorted_acc = sorted(r.accuracy_m for r in run)
    idx = max(0, min(len(sorted_acc) - 1, int(math.ceil(0.95 * len(sorted_acc)) - 1)))
    p95 = sorted_acc[idx]

    return StayPoint(
        start_ts=run[0].ts,
        end_ts=run[-1].ts,
        centroid_lat=cx_lat,
        centroid_lng=cx_lng,
        event_ids=tuple(r.id for r in run),
        point_count=len(run),
        p95_accuracy_m=p95,
        dwell_s=dwell_s,
    )
