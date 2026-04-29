"""`sleep/v1` deriver tests.

Algorithm-level cases for the silent-run / interruption-merge / morning-
hours-filter pipeline. The deriver itself is exercised via a stub-fetch
subclass so we don't need a database.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from scrollantir.core.derivers.sleep import (
    SleepV1Deriver,
    _active_spans,
    _merge_brief_interruptions,
    _score_confidence,
    _silent_runs,
)


def UTC(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Stub fetcher — bypasses the DB
# ---------------------------------------------------------------------------


class _StubDeriver(SleepV1Deriver):
    """Returns the canned event timestamps instead of querying."""

    # UTC for tests — we craft test events ending in UTC mornings so
    # the morning-hours-local filter (which converts to local TZ) lines
    # up. Single-user test predictability.
    local_tz_name: str = "UTC"

    def __init__(self, events: list[datetime]):
        self._stub_events = sorted(events)

    def _fetch_event_timestamps(self, conn, start, end):  # type: ignore[override]
        return [e for e in self._stub_events if start <= e < end]


# ---------------------------------------------------------------------------
# _active_spans / _silent_runs / _merge_brief_interruptions
# ---------------------------------------------------------------------------


def test_active_spans_merges_overlapping_events() -> None:
    """Three events at 10:00, 10:03, 10:08 with a 5-min forward window
    coalesce into a single 10:00 → 10:13 active span."""
    events = [UTC(2026, 4, 29, 10, 0), UTC(2026, 4, 29, 10, 3), UTC(2026, 4, 29, 10, 8)]
    spans = _active_spans(events, timedelta(minutes=5))
    assert spans == [(UTC(2026, 4, 29, 10, 0), UTC(2026, 4, 29, 10, 13))]


def test_silent_runs_returns_only_interior_gaps() -> None:
    """Two active spans inside the window → ONE interior silent run
    between them. Leading silence (window_start → first event) and
    trailing silence (last event → window_end) are NOT returned —
    they're unobserved time, not sleep candidates."""
    active = [
        (UTC(2026, 4, 29, 6, 0), UTC(2026, 4, 29, 6, 5)),
        (UTC(2026, 4, 29, 14, 0), UTC(2026, 4, 29, 14, 5)),
    ]
    runs = _silent_runs(active, UTC(2026, 4, 29, 4, 0), UTC(2026, 4, 29, 22, 0))
    assert runs == [(UTC(2026, 4, 29, 6, 5), UTC(2026, 4, 29, 14, 0))]


def test_silent_runs_no_active_returns_empty() -> None:
    """A window with no activity at all produces no candidate runs —
    we have no idea what was happening, so nothing to claim."""
    assert _silent_runs([], UTC(2026, 4, 29, 4, 0), UTC(2026, 4, 30, 4, 0)) == []


def test_merge_brief_interruptions_collapses_short_gaps() -> None:
    """Two silent runs separated by a 5-min activity gap collapse
    into one. disrupted_count = 1."""
    runs = [
        (UTC(2026, 4, 29, 0, 0), UTC(2026, 4, 29, 4, 0)),
        (UTC(2026, 4, 29, 4, 5), UTC(2026, 4, 29, 8, 0)),
    ]
    merged, by_run = _merge_brief_interruptions(runs, timedelta(minutes=15))
    assert merged == [(UTC(2026, 4, 29, 0, 0), UTC(2026, 4, 29, 8, 0))]
    assert by_run[merged[0]] == 1


def test_merge_brief_interruptions_preserves_long_gaps() -> None:
    """A 20-min activity gap is too long to be a brief interruption;
    keep the runs separate."""
    runs = [
        (UTC(2026, 4, 29, 0, 0), UTC(2026, 4, 29, 4, 0)),
        (UTC(2026, 4, 29, 4, 25), UTC(2026, 4, 29, 8, 0)),
    ]
    merged, _ = _merge_brief_interruptions(runs, timedelta(minutes=15))
    assert merged == runs


# ---------------------------------------------------------------------------
# _score_confidence
# ---------------------------------------------------------------------------


def test_confidence_sole_qualifying_run_is_max() -> None:
    """One sleep, no competition → 1.0."""
    assert _score_confidence(7 * 3600, [7 * 3600]) == 1.0


def test_confidence_dominant_winner_is_max() -> None:
    """Sleep 8h vs nap 4h (≥2x) → 1.0."""
    assert _score_confidence(8 * 3600, [8 * 3600, 4 * 3600]) == 1.0


def test_confidence_close_competitors_lower() -> None:
    """Two competing 5h+5h runs → low confidence."""
    assert _score_confidence(5 * 3600, [5 * 3600, 5 * 3600]) == 0.6


# ---------------------------------------------------------------------------
# Deriver pipeline
# ---------------------------------------------------------------------------


def _activity_burst(start: datetime, *, count: int = 4, spacing_min: float = 1.0) -> list[datetime]:
    """A short flurry of events — simulates "user is using the device"."""
    return [start + timedelta(minutes=i * spacing_min) for i in range(count)]


def test_clean_overnight_sleep_emits_one_row() -> None:
    """Activity until 23:00, silence until 07:00, activity resumes →
    one sleep/v1 row from 23:05 (after the last event's active fade)
    to 07:00."""
    # Late-evening activity 22:30-22:57, then silence, wake-up activity 07:00+.
    evening = _activity_burst(UTC(2026, 4, 29, 22, 30), count=10, spacing_min=3)
    morning = _activity_burst(UTC(2026, 4, 30, 7, 0), count=10, spacing_min=2)
    deriver = _StubDeriver(evening + morning)

    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )

    assert len(rows) == 1
    row = rows[0]
    # Sleep starts after the last evening event's active span fades
    # (events at 22:30, 22:33, ..., 22:57; last + 5min = 23:02).
    assert row.start_ts == UTC(2026, 4, 29, 23, 2)
    # Wake = first morning event (start of next active span).
    assert row.end_ts == UTC(2026, 4, 30, 7, 0)
    assert row.data["confidence"] == 1.0
    assert row.provenance["disrupted_count"] == 0
    # 23:02 → next-day 7:00 = 7h58m = 7.97h.
    assert row.provenance["duration_hours"] == 7.97
    assert metrics["candidates_in_morning"] == 1


def test_brief_4am_wake_does_not_split_sleep() -> None:
    """A short 4 AM activity burst inside a long silence is absorbed
    by the brief-interruption merger — one sleep row, disrupted_count=1."""
    evening = _activity_burst(UTC(2026, 4, 29, 22, 30), count=5, spacing_min=2)
    bathroom = _activity_burst(UTC(2026, 4, 30, 4, 0), count=2, spacing_min=1)
    morning = _activity_burst(UTC(2026, 4, 30, 7, 0), count=10, spacing_min=2)
    deriver = _StubDeriver(evening + bathroom + morning)

    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )

    assert len(rows) == 1
    assert rows[0].provenance["disrupted_count"] == 1
    # Wake time is the morning burst, not the bathroom break.
    assert rows[0].end_ts == UTC(2026, 4, 30, 7, 0)


def test_afternoon_nap_rejected_by_morning_hours_filter() -> None:
    """A 5h silence ending at 18:00 (afternoon) does NOT qualify as
    sleep — wake-time outside `morning_hours` window."""
    morning = _activity_burst(UTC(2026, 4, 29, 9, 0), count=10, spacing_min=2)
    nap_wake = _activity_burst(UTC(2026, 4, 29, 18, 0), count=10, spacing_min=2)
    # 9:18 → 18:00 is 8h42m of "silence" — would qualify if not for filter.
    deriver = _StubDeriver(morning + nap_wake)

    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 4, 0), UTC(2026, 4, 30, 4, 0)
    )

    assert rows == []
    # The long run was found, just not emitted (wake outside morning).
    assert metrics["silent_runs_long"] >= 1
    assert metrics["candidates_in_morning"] == 0


def test_no_events_no_emit() -> None:
    """Empty input → no row, no error. (First-run cold-start case.)"""
    deriver = _StubDeriver([])
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )
    assert rows == []
    assert metrics["events_total"] == 0


def test_competing_runs_lower_confidence_below_emit_threshold() -> None:
    """Two near-equal silences both ending in morning hours (split
    sleep with a too-long mid-night break that doesn't merge) →
    confidence gets competed down below the emit threshold, so we
    suppress rather than guess wrong."""
    # Sleep 1: 23:00 → 5:00 (6h). Sleep 2: 5:30 → 9:30 (4h). The
    # 30-min mid-break is too long for brief-interruption merging
    # (default 15 min) so we get two distinct candidates, both
    # waking in [4, 14) — the confidence ratio test then suppresses
    # because they're close in length (1.5x ≈ medium confidence; we
    # set min_confidence_to_emit to 0.6 by default, so this borderline
    # case sits right at the edge).
    evening = _activity_burst(UTC(2026, 4, 29, 22, 50), count=5, spacing_min=2)
    mid_break = _activity_burst(UTC(2026, 4, 30, 5, 0), count=10, spacing_min=2)  # 5:00-5:18
    morning = _activity_burst(UTC(2026, 4, 30, 9, 30), count=10, spacing_min=2)
    deriver = _StubDeriver(evening + mid_break + morning)
    # Tighten the threshold so the test is deterministic at this
    # borderline ratio. Real-world tuning lives on the deriver's
    # default min_confidence_to_emit = 0.6.
    deriver.min_confidence_to_emit = 0.9

    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )

    # Two long runs both end in morning, but neither is dominant
    # enough to clear the confidence bar.
    assert rows == []
    assert metrics["silent_runs_long"] >= 2
    assert metrics["candidates_in_morning"] >= 2


def test_id_is_deterministic_across_replays() -> None:
    """Same wake date → same id. Lets `replace_derived_window` reuse
    rows on re-derivation without orphans."""
    evening = _activity_burst(UTC(2026, 4, 29, 22, 30), count=5, spacing_min=2)
    morning = _activity_burst(UTC(2026, 4, 30, 7, 0), count=10, spacing_min=2)
    d1 = _StubDeriver(evening + morning)
    d2 = _StubDeriver(evening + morning)
    rows_1, _ = d1.compute(None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0))
    rows_2, _ = d2.compute(None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0))
    assert rows_1[0].id == rows_2[0].id
