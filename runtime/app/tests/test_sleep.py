"""`sleep/v1` deriver tests.

Sleep depends on `user_active/v1` rows. Tests use a stub-fetch
subclass to feed in synthetic active-span boundaries directly,
bypassing both the DB and the user_active deriver itself.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from scrollantir.core.derivers.sleep import (
    SleepV1Deriver,
    _merge_brief_interruptions,
    _silent_runs,
)


def UTC(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


class _StubDeriver(SleepV1Deriver):
    """Returns canned active spans instead of querying derived_events.
    Tests pin local TZ to UTC so morning-hours filtering aligns with
    the test data's UTC-keyed timestamps.

    The stub honors the deriver's lookback so tests can construct
    bracketing spans whose start_ts is before the deriver's window
    (in lookback range)."""

    local_tz_name: str = "UTC"

    def __init__(self, active_spans: list[tuple[datetime, datetime]]):
        self._stub = sorted(active_spans)

    def _fetch_active_spans(self, conn, start, end):  # type: ignore[override]
        fetch_start = start - timedelta(hours=self.fetch_lookback_hours)
        return [
            (s, e) for (s, e) in self._stub
            if s >= fetch_start and s < end
        ]


# ---------------------------------------------------------------------------
# Pure-helper tests
# ---------------------------------------------------------------------------


def test_silent_runs_returns_only_interior_gaps() -> None:
    """Silent runs are gaps BETWEEN consecutive active spans —
    leading silence (before the first span) and trailing silence
    (after the last) are excluded."""
    spans = [
        (UTC(2026, 4, 29, 6, 0), UTC(2026, 4, 29, 6, 5)),
        (UTC(2026, 4, 29, 14, 0), UTC(2026, 4, 29, 14, 5)),
    ]
    runs = _silent_runs(spans)
    assert runs == [(UTC(2026, 4, 29, 6, 5), UTC(2026, 4, 29, 14, 0))]


def test_silent_runs_no_clamping_to_window() -> None:
    """Spans before and after a hypothetical window: silent_runs
    reports the TRUE gap between them, NOT a window-clamped version.
    Critical for skip-pre-window correctness — clamping would falsify
    the onset, then the skip rule (s < window_start) wouldn't fire on
    runs that earlier ticks already owned."""
    spans = [
        (UTC(2026, 4, 28, 22, 0), UTC(2026, 4, 28, 23, 0)),  # pre-"window"
        (UTC(2026, 4, 29, 7, 0), UTC(2026, 4, 29, 8, 0)),     # post-"window"
    ]
    runs = _silent_runs(spans)
    # True gap, NOT clamped to anyone's window:
    assert runs == [(UTC(2026, 4, 28, 23, 0), UTC(2026, 4, 29, 7, 0))]


def test_silent_runs_no_spans_returns_empty() -> None:
    assert _silent_runs([]) == []


def test_merge_brief_interruptions_collapses_short_activity() -> None:
    """Two silent runs separated by 4-min activity (≤ 5 min) → merge."""
    runs = [
        (UTC(2026, 4, 29, 0, 0), UTC(2026, 4, 29, 4, 0)),
        (UTC(2026, 4, 29, 4, 4), UTC(2026, 4, 29, 8, 0)),
    ]
    merged, by_run = _merge_brief_interruptions(runs, timedelta(minutes=5))
    assert merged == [(UTC(2026, 4, 29, 0, 0), UTC(2026, 4, 29, 8, 0))]
    assert by_run[merged[0]] == 1


def test_merge_brief_interruptions_preserves_long_activity() -> None:
    """10-min activity gap is too long to be a brief interruption —
    keep two separate runs."""
    runs = [
        (UTC(2026, 4, 29, 0, 0), UTC(2026, 4, 29, 4, 0)),
        (UTC(2026, 4, 29, 4, 10), UTC(2026, 4, 29, 8, 0)),
    ]
    merged, _ = _merge_brief_interruptions(runs, timedelta(minutes=5))
    assert merged == runs


# ---------------------------------------------------------------------------
# Deriver pipeline
# ---------------------------------------------------------------------------


def test_clean_overnight_emits_one_night_row() -> None:
    """Active span ending 23:00, then 7-hour silence, then active
    span at 06:00 → ONE row, kind='night', is_primary in spirit."""
    spans = [
        (UTC(2026, 4, 29, 22, 0), UTC(2026, 4, 29, 23, 0)),
        (UTC(2026, 4, 30, 6, 0), UTC(2026, 4, 30, 7, 0)),
    ]
    deriver = _StubDeriver(spans)

    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )

    assert len(rows) == 1
    assert rows[0].data["kind"] == "night"
    assert rows[0].start_ts == UTC(2026, 4, 29, 23, 0)
    assert rows[0].end_ts == UTC(2026, 4, 30, 6, 0)
    assert rows[0].provenance["duration_minutes"] == 420.0  # 7h
    assert rows[0].data["wake_local_date"] == "2026-04-30"
    assert metrics["nights_emitted"] == 1
    assert metrics["naps_emitted"] == 0


def test_below_nap_floor_emits_nothing() -> None:
    """Silent run < 90 min is below nap_floor → not emitted."""
    spans = [
        (UTC(2026, 4, 29, 22, 0), UTC(2026, 4, 29, 23, 0)),
        (UTC(2026, 4, 29, 23, 30), UTC(2026, 4, 30, 0, 0)),  # 30-min silence
    ]
    deriver = _StubDeriver(spans)
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )
    assert rows == []
    assert metrics["silent_runs_long"] == 0


def test_short_overnight_below_night_floor_classified_as_nap() -> None:
    """Silent run ≥ 90 min but < 180 min ending in morning hours →
    classifies as 'nap', NOT 'night'. /today's day boundary then
    falls back to 04:00, which is the design intent (we don't trust
    short silences enough to anoint them as 'the night')."""
    spans = [
        (UTC(2026, 4, 30, 4, 0), UTC(2026, 4, 30, 4, 30)),
        (UTC(2026, 4, 30, 6, 30), UTC(2026, 4, 30, 7, 0)),  # 120 min silence
    ]
    deriver = _StubDeriver(spans)
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )
    assert len(rows) == 1
    assert rows[0].data["kind"] == "nap"
    assert metrics["nights_emitted"] == 0
    assert metrics["naps_emitted"] == 1


def test_long_silence_outside_morning_hours_is_nap_not_night() -> None:
    """5h silence ending at 19:00 local — long enough for 'night'
    but wakes outside [04, 14) → demoted to nap. Common-sense audit's
    'movie night classified as the day's main sleep' guard."""
    spans = [
        (UTC(2026, 4, 29, 13, 0), UTC(2026, 4, 29, 14, 0)),
        (UTC(2026, 4, 29, 19, 0), UTC(2026, 4, 29, 20, 0)),  # 5h silence
    ]
    deriver = _StubDeriver(spans)
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 12, 0), UTC(2026, 4, 30, 4, 0)
    )
    assert len(rows) == 1
    assert rows[0].data["kind"] == "nap"


def test_night_plus_two_naps_in_one_day() -> None:
    """Real overnight (8h) + two afternoon naps (90+ min each) →
    one 'night' + two 'nap' rows, ranked by start_ts."""
    spans = [
        # Pre-sleep: brief evening
        (UTC(2026, 4, 28, 22, 0), UTC(2026, 4, 28, 23, 0)),
        # Wake at 7 AM (8h sleep)
        (UTC(2026, 4, 29, 7, 0), UTC(2026, 4, 29, 8, 0)),
        # Bracketing nap 1 (12:00 - 13:30 silence = 90 min)
        (UTC(2026, 4, 29, 13, 30), UTC(2026, 4, 29, 14, 0)),
        # Bracketing nap 2 (16:00 - 17:30 silence = 90 min)
        (UTC(2026, 4, 29, 17, 30), UTC(2026, 4, 29, 18, 0)),
    ]
    deriver = _StubDeriver(spans)
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 28, 18, 0), UTC(2026, 4, 30, 0, 0)
    )

    by_kind = [(r.data["kind"], r.provenance["rank"]) for r in rows]
    # Order in emit list: night first, then naps in chronological order.
    assert by_kind == [("night", 0), ("nap", 0), ("nap", 1)]
    assert metrics["nights_emitted"] == 1
    assert metrics["naps_emitted"] == 2


def test_naps_capped_at_max_per_day() -> None:
    """Four nap-eligible silences in one day → cap at
    max_naps_per_day=2 longest. Silences computed as the GAPS between
    consecutive active spans:
      span1 08:00 → span2 10:30  → silent run 150min
      span2 11:00 → span3 13:35  → silent run 155min  ← longest
      span3 14:00 → span4 16:32  → silent run 152min  ← second
      span4 17:00 → span5 19:31  → silent run 151min
    None reach the night_floor (180), so all are naps. Cap = 2."""
    spans = [
        (UTC(2026, 4, 29, 7, 0), UTC(2026, 4, 29, 8, 0)),
        (UTC(2026, 4, 29, 10, 30), UTC(2026, 4, 29, 11, 0)),
        (UTC(2026, 4, 29, 13, 35), UTC(2026, 4, 29, 14, 0)),
        (UTC(2026, 4, 29, 16, 32), UTC(2026, 4, 29, 17, 0)),
        (UTC(2026, 4, 29, 19, 31), UTC(2026, 4, 29, 20, 0)),
    ]
    deriver = _StubDeriver(spans)
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 6, 0), UTC(2026, 4, 30, 0, 0)
    )
    assert metrics["nights_emitted"] == 0
    assert metrics["naps_emitted"] == 2
    assert all(r.data["kind"] == "nap" for r in rows)
    durations = [r.provenance["duration_minutes"] for r in rows]
    assert sorted(durations, reverse=True) == [155.0, 152.0]


def test_brief_4am_wake_does_not_split_night() -> None:
    """Bathroom break at 4 AM (3-min active span) inside an overnight
    silence — merged via brief-interruption tolerance."""
    spans = [
        (UTC(2026, 4, 29, 22, 0), UTC(2026, 4, 29, 23, 0)),
        # Bathroom break: brief active span at 4 AM lasting 3 min
        (UTC(2026, 4, 30, 4, 0), UTC(2026, 4, 30, 4, 3)),
        (UTC(2026, 4, 30, 7, 0), UTC(2026, 4, 30, 8, 0)),
    ]
    deriver = _StubDeriver(spans)
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )
    assert len(rows) == 1
    assert rows[0].data["kind"] == "night"
    assert rows[0].provenance["disrupted_count"] == 1
    assert rows[0].start_ts == UTC(2026, 4, 29, 23, 0)
    assert rows[0].end_ts == UTC(2026, 4, 30, 7, 0)


def test_id_stable_across_replay() -> None:
    """Same wake_local_date + kind + rank → same uuid. Boundary
    jitter (a single new event shifting silent_run start by seconds)
    doesn't change the id; replace_derived_window UPSERT semantics
    hold."""
    spans = [
        (UTC(2026, 4, 29, 22, 0), UTC(2026, 4, 29, 23, 0)),
        (UTC(2026, 4, 30, 7, 0), UTC(2026, 4, 30, 8, 0)),
    ]
    d1 = _StubDeriver(spans)
    d2 = _StubDeriver(spans)
    rows_1, _ = d1.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )
    rows_2, _ = d2.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )
    assert rows_1[0].id == rows_2[0].id


def test_id_stable_under_boundary_jitter() -> None:
    """Two replays with slightly-different boundary timestamps but
    same (wake_local_date, kind, rank) → same id. This is the property
    the technical audit specifically called out as broken under the
    old `uuid5(sleep_start_iso_seconds)` scheme."""
    spans_a = [
        (UTC(2026, 4, 29, 22, 0), UTC(2026, 4, 29, 23, 0)),
        (UTC(2026, 4, 30, 7, 0), UTC(2026, 4, 30, 8, 0)),
    ]
    spans_b = [
        # End of first active span shifted 30s later → silent_run
        # start_ts shifts 30s later, but we should still classify as
        # the same 'night' on the same wake_local_date.
        (UTC(2026, 4, 29, 22, 0), UTC(2026, 4, 29, 23, 0) + timedelta(seconds=30)),
        (UTC(2026, 4, 30, 7, 0), UTC(2026, 4, 30, 8, 0)),
    ]
    rows_a, _ = _StubDeriver(spans_a).compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )
    rows_b, _ = _StubDeriver(spans_b).compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )
    assert rows_a[0].id == rows_b[0].id


def test_no_spans_returns_no_rows() -> None:
    """First-run cold start: no user_active rows yet."""
    deriver = _StubDeriver([])
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 18, 0), UTC(2026, 4, 30, 14, 0)
    )
    assert rows == []
    assert metrics["active_spans_total"] == 0


def test_silence_starting_before_window_is_emitted_under_overlap() -> None:
    """Under OVERLAP_REPLACE: a sleep whose onset is in lookback but
    whose wake is in the window IS emitted with its true sleep_start.
    The framework's overlap-mode delete dedupes against earlier ticks'
    identically-keyed (wake_local_date, kind, rank) rows.

    Sequence:
      - active span 22:00-23:00 yesterday  ← lookback-only bracket
      - active span 07:00-08:00 today      ← wake-side bracket
      - silent_run = (yesterday 23:00, today 07:00) — true onset,
        wake at 07:00 today. END is in window → emit.
    """
    spans = [
        (UTC(2026, 4, 28, 22, 0), UTC(2026, 4, 28, 23, 0)),
        (UTC(2026, 4, 29, 7, 0), UTC(2026, 4, 29, 8, 0)),
    ]
    deriver = _StubDeriver(spans)
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 4, 0), UTC(2026, 4, 30, 4, 0)
    )
    # Emitted with onset before window_start.
    assert len(rows) == 1
    assert rows[0].start_ts == UTC(2026, 4, 28, 23, 0)
    assert rows[0].end_ts == UTC(2026, 4, 29, 7, 0)
    assert metrics["silent_runs_long"] == 1


def test_lookback_lets_pre_window_span_bracket_in_window_silence() -> None:
    """When the silent_run's ONSET is in window but the bracketing
    previous user_active row has start_ts before window_start (visible
    only via lookback): the run should be detected and emitted.

    This is the case that without lookback would be silently dropped —
    sleep would see only the wake span and treat the silence as
    leading (excluded by interior-only logic).
    """
    spans = [
        # Previous span: starts in lookback, ends INSIDE window. The
        # silent_run after it is fully in-window.
        (UTC(2026, 4, 29, 3, 30), UTC(2026, 4, 29, 4, 30)),
        # Wake span: 04:30 + 4h silence = wake at 08:30
        (UTC(2026, 4, 29, 8, 30), UTC(2026, 4, 29, 9, 30)),
    ]
    deriver = _StubDeriver(spans)
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 4, 0), UTC(2026, 4, 30, 4, 0)
    )
    # silent_run = (04:30, 08:30) = 4h. Onset 04:30 >= window_start
    # 04:00 → emit. Wake at 08:30 in [04, 14) → kind='night'.
    assert len(rows) == 1
    assert rows[0].data["kind"] == "night"
    assert rows[0].start_ts == UTC(2026, 4, 29, 4, 30)
    assert rows[0].end_ts == UTC(2026, 4, 29, 8, 30)
    assert rows[0].provenance["duration_minutes"] == 240.0
