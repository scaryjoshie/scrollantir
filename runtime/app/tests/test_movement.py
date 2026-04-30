"""`movement/v1` deriver tests.

Covers segmentation correctness (the core change vs. travel_leg/v1):
  - movement with both bracketing visits (the easy case)
  - movement with only a from_visit (sub-threshold destination, the
    morning-walk case)
  - movement with only a to_visit (sub-threshold origin)
  - movement with neither (genuine wandering / cold-start)
  - gap-threshold splits one stretch into two movements
  - readings inside a place_visit don't form a movement
  - too-short runs are dropped
  - too-brief-distance runs are dropped (GPS wobble during a stay
    that didn't quite get place-matched)
"""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import UUID, uuid4

from scrollantir.core.derivers.movement import (
    MovementV1Deriver,
    _Reading,
    _VisitRef,
    _segment_motion_runs,
)

from .conftest import (
    NORRIS,
    SARGENT,
    TECH,
    UTC,
    offset_meters,
)


# ---------------------------------------------------------------------------
# Stub deriver (no DB, returns canned readings + visits)
# ---------------------------------------------------------------------------


class _StubMovementDeriver(MovementV1Deriver):
    """Test subclass with stubbed fetchers + activity classifier."""

    def __init__(
        self,
        readings: list[_Reading],
        visits: list[_VisitRef],
        activity: str | None = "walking",
    ):
        self._stub_readings = readings
        self._stub_visits = visits
        self._stub_activity = activity

    def _fetch_readings(self, conn, start, end):  # type: ignore[override]
        return self._stub_readings

    def _fetch_visits(self, conn, start, end):  # type: ignore[override]
        return self._stub_visits

    def _dominant_activity(self, conn, run_start, run_end):  # type: ignore[override]
        return self._stub_activity


# ---------------------------------------------------------------------------
# Reading helpers
# ---------------------------------------------------------------------------


def _readings_walk(
    start: tuple[float, float],
    end: tuple[float, float],
    *,
    start_ts: datetime,
    n: int = 10,
    interval_s: float = 30.0,
) -> list[_Reading]:
    """Linearly-interpolated readings between two coords."""
    out: list[_Reading] = []
    for i in range(n):
        frac = i / max(n - 1, 1)
        lat = start[0] + (end[0] - start[0]) * frac
        lng = start[1] + (end[1] - start[1]) * frac
        ts = start_ts + timedelta(seconds=i * interval_s)
        out.append(_Reading(id=str(uuid4()), ts=ts, lng=lng, lat=lat))
    return out


def _visit(
    *,
    start_ts: datetime,
    end_ts: datetime,
) -> _VisitRef:
    return _VisitRef(id=uuid4(), start_ts=start_ts, end_ts=end_ts)


# ---------------------------------------------------------------------------
# _segment_motion_runs (pure helper)
# ---------------------------------------------------------------------------


def test_segment_no_visits_one_run() -> None:
    """All readings outside any visit collapse to one run with no
    bracketing visits."""
    start = UTC(2026, 4, 30, 10, 0)
    readings = _readings_walk(NORRIS, TECH, start_ts=start, n=8)
    runs = _segment_motion_runs(
        readings, visits=[], gap_threshold=timedelta(minutes=15)
    )
    assert len(runs) == 1
    run, prev, nxt = runs[0]
    assert len(run) == 8
    assert prev is None
    assert nxt is None


def test_segment_visit_in_middle_splits_run() -> None:
    """Readings on either side of a visit form two separate runs.
    The visit shows up as `next` for the first run and `prev` for
    the second."""
    start = UTC(2026, 4, 30, 10, 0)
    pre = _readings_walk(NORRIS, TECH, start_ts=start, n=4, interval_s=30)
    visit = _visit(
        start_ts=start + timedelta(minutes=5),
        end_ts=start + timedelta(minutes=15),
    )
    # Add some readings inside the visit (they should NOT join either run)
    in_visit = [
        _Reading(
            id=str(uuid4()),
            ts=start + timedelta(minutes=10),
            lng=TECH[1],
            lat=TECH[0],
        )
    ]
    post = _readings_walk(
        TECH,
        SARGENT,
        start_ts=start + timedelta(minutes=20),
        n=4,
        interval_s=30,
    )
    readings = pre + in_visit + post

    runs = _segment_motion_runs(
        readings, visits=[visit], gap_threshold=timedelta(minutes=15)
    )
    assert len(runs) == 2
    pre_run, pre_prev, pre_next = runs[0]
    post_run, post_prev, post_next = runs[1]
    assert len(pre_run) == 4
    assert pre_prev is None  # nothing before
    assert pre_next == visit
    assert len(post_run) == 4
    assert post_prev == visit
    assert post_next is None


def test_segment_gap_threshold_splits_run() -> None:
    """A gap > gap_threshold between two in-motion readings starts a
    new run. Models trackintel's gap_threshold (15 min default)."""
    start = UTC(2026, 4, 30, 10, 0)
    early = _readings_walk(NORRIS, TECH, start_ts=start, n=3, interval_s=30)
    # 30-minute gap
    late_start = start + timedelta(minutes=30)
    late = _readings_walk(TECH, SARGENT, start_ts=late_start, n=3, interval_s=30)
    runs = _segment_motion_runs(
        early + late, visits=[], gap_threshold=timedelta(minutes=15)
    )
    assert len(runs) == 2


def test_segment_handles_brief_exit_in_visit() -> None:
    """A reading that LANDS exactly inside a visit's [start, end] is
    classified as in-visit and ends the current run."""
    start = UTC(2026, 4, 30, 10, 0)
    # Visit spans 10:02-10:08
    visit = _visit(
        start_ts=start + timedelta(minutes=2),
        end_ts=start + timedelta(minutes=8),
    )
    readings = [
        # 10:00 - in motion (before visit)
        _Reading(
            id=str(uuid4()), ts=start, lng=NORRIS[1], lat=NORRIS[0]
        ),
        _Reading(
            id=str(uuid4()),
            ts=start + timedelta(minutes=1),
            lng=NORRIS[1],
            lat=NORRIS[0],
        ),
        # 10:05 - in visit (should not be in any run)
        _Reading(
            id=str(uuid4()),
            ts=start + timedelta(minutes=5),
            lng=NORRIS[1],
            lat=NORRIS[0],
        ),
        # 10:10 - in motion (after visit)
        _Reading(
            id=str(uuid4()),
            ts=start + timedelta(minutes=10),
            lng=TECH[1],
            lat=TECH[0],
        ),
    ]
    runs = _segment_motion_runs(
        readings, visits=[visit], gap_threshold=timedelta(minutes=20)
    )
    # Should produce two runs: the 10:00-10:01 pair before, and the 10:10
    # singleton after. The deriver's min_readings filter may drop the
    # singleton, but segmentation alone produces them.
    assert len(runs) == 2
    pre_run, _, pre_next = runs[0]
    post_run, post_prev, _ = runs[1]
    assert len(pre_run) == 2
    assert pre_next == visit
    assert len(post_run) == 1
    assert post_prev == visit


# ---------------------------------------------------------------------------
# Full deriver integration (uses _smooth_path, distance filter, etc.)
# ---------------------------------------------------------------------------


def test_movement_emits_with_both_visits_bracketing() -> None:
    """The 'easy' case: walk between two visits emits a movement with
    both from_visit_id and to_visit_id set."""
    start = UTC(2026, 4, 30, 10, 0)
    norris_visit = _visit(
        start_ts=start - timedelta(minutes=5),
        end_ts=start,
    )
    walk = _readings_walk(
        NORRIS, TECH, start_ts=start + timedelta(seconds=30), n=10
    )
    tech_visit = _visit(
        start_ts=start + timedelta(minutes=10),
        end_ts=start + timedelta(minutes=30),
    )
    deriver = _StubMovementDeriver(
        readings=walk, visits=[norris_visit, tech_visit]
    )

    rows, _metrics = deriver.compute(
        None, start, start + timedelta(hours=1)
    )

    assert len(rows) == 1
    row = rows[0]
    assert row.data["from_visit_id"] == str(norris_visit.id)
    assert row.data["to_visit_id"] == str(tech_visit.id)
    assert row.data["dominant_activity"] == "walking"
    assert row.data["distance_m"] > 0


def test_movement_emits_with_null_to_visit_morning_walk_case() -> None:
    """The bug we're fixing: walk ends with a sub-threshold stop, no
    destination visit. Movement still emits, with to_visit_id NULL.

    This is the morning 03:30-03:55 walk that travel_leg/v1 dropped."""
    start = UTC(2026, 4, 30, 8, 0)
    home_visit = _visit(
        start_ts=start - timedelta(hours=8),
        end_ts=start,
    )
    walk = _readings_walk(
        NORRIS, TECH, start_ts=start + timedelta(seconds=30), n=10
    )
    deriver = _StubMovementDeriver(
        readings=walk,
        visits=[home_visit],
    )
    rows, _metrics = deriver.compute(
        None, start, start + timedelta(hours=1)
    )

    assert len(rows) == 1
    row = rows[0]
    assert row.data["from_visit_id"] == str(home_visit.id)
    assert row.data["to_visit_id"] is None  # ← THE FIX
    assert row.data["distance_m"] > 0


def test_movement_emits_with_null_from_visit_cold_start() -> None:
    """Tracking turns on mid-walk: no preceding visit, but ends at one."""
    start = UTC(2026, 4, 30, 10, 0)
    arrival = _visit(
        start_ts=start + timedelta(minutes=10),
        end_ts=start + timedelta(minutes=30),
    )
    walk = _readings_walk(NORRIS, TECH, start_ts=start, n=10)
    deriver = _StubMovementDeriver(readings=walk, visits=[arrival])

    rows, _metrics = deriver.compute(
        None, start, start + timedelta(hours=1)
    )

    assert len(rows) == 1
    row = rows[0]
    assert row.data["from_visit_id"] is None
    assert row.data["to_visit_id"] == str(arrival.id)


def test_movement_emits_with_no_visits_pure_pass_through() -> None:
    """Both bracketing FKs NULL: tracking on/off mid-trip."""
    start = UTC(2026, 4, 30, 10, 0)
    walk = _readings_walk(NORRIS, TECH, start_ts=start, n=10)
    deriver = _StubMovementDeriver(readings=walk, visits=[])

    rows, _metrics = deriver.compute(
        None, start, start + timedelta(hours=1)
    )

    assert len(rows) == 1
    assert rows[0].data["from_visit_id"] is None
    assert rows[0].data["to_visit_id"] is None


def test_movement_skips_too_brief_distance() -> None:
    """A run that doesn't actually cover much ground (GPS wobble during
    a too-brief-to-be-a-stay sit) is filtered by min_distance_m."""
    start = UTC(2026, 4, 30, 10, 0)
    # 10 readings all at NORRIS — no actual movement.
    readings = [
        _Reading(
            id=str(uuid4()),
            ts=start + timedelta(seconds=i * 30),
            lng=NORRIS[1],
            lat=NORRIS[0],
        )
        for i in range(10)
    ]
    deriver = _StubMovementDeriver(readings=readings, visits=[])

    rows, metrics = deriver.compute(
        None, start, start + timedelta(hours=1)
    )

    assert len(rows) == 0
    assert metrics["runs_detected"] == 1
    assert metrics["runs_skipped_too_brief_distance"] == 1


def test_movement_deterministic_id_stable_across_replays() -> None:
    """Same readings → same id. Replays produce identical movement
    rows so OVERLAP_REPLACE doesn't fragment history."""
    start = UTC(2026, 4, 30, 10, 0)
    walk = _readings_walk(NORRIS, TECH, start_ts=start, n=10)
    d1 = _StubMovementDeriver(readings=walk, visits=[])
    d2 = _StubMovementDeriver(readings=walk, visits=[])

    rows1, _ = d1.compute(None, start, start + timedelta(hours=1))
    rows2, _ = d2.compute(None, start, start + timedelta(hours=1))

    assert len(rows1) == 1
    assert len(rows2) == 1
    assert rows1[0].id == rows2[0].id


def test_movement_skips_pre_window_runs() -> None:
    """Runs whose entire span is in lookback (run_end <= window_start)
    are skipped per OVERLAP_REPLACE — they were emitted by a prior tick."""
    window_start = UTC(2026, 4, 30, 10, 0)
    pre_window_walk = _readings_walk(
        NORRIS, TECH, start_ts=window_start - timedelta(hours=1), n=10
    )
    deriver = _StubMovementDeriver(readings=pre_window_walk, visits=[])

    rows, metrics = deriver.compute(
        None, window_start, window_start + timedelta(hours=1)
    )
    assert len(rows) == 0
    assert metrics["runs_skipped_pre_window"] >= 1
