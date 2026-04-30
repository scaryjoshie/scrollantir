"""`user_active/v1` deriver tests.

The deriver clusters raw interaction events into contiguous activity
spans. Tests use a stub-fetch subclass to skip the DB.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from scrollantir.core.derivers.user_active import (
    UserActiveV1Deriver,
    _deterministic_span_id,
)


def UTC(year: int, month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)


class _StubFetcher(UserActiveV1Deriver):
    """Returns canned events instead of querying public.events."""

    def __init__(self, events: list[tuple[datetime, str, UUID]]):
        self._stub = sorted(events, key=lambda e: (e[0], str(e[2])))

    def _fetch_events(self, conn, start, end):  # type: ignore[override]
        return [(t, s, i) for (t, s, i) in self._stub if start <= t < end]


def _evt(ts: datetime, src: str = "phone.system.foreground") -> tuple[datetime, str, UUID]:
    return (ts, src, uuid4())


# ---------------------------------------------------------------------------
# Empty / single-event cases
# ---------------------------------------------------------------------------


def test_empty_input_emits_no_rows() -> None:
    deriver = _StubFetcher([])
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 10, 0), UTC(2026, 4, 29, 12, 0)
    )
    assert rows == []
    assert metrics["spans_total"] == 0
    assert metrics["events_total"] == 0


def test_single_event_emits_one_span_with_trailing_fade() -> None:
    """One event at 10:00 → span [10:00, 10:05). end_ts is event ts +
    trailing_fade_min (5)."""
    e = _evt(UTC(2026, 4, 29, 10, 0))
    deriver = _StubFetcher([e])
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 9, 30), UTC(2026, 4, 29, 12, 0)
    )
    assert len(rows) == 1
    assert rows[0].start_ts == UTC(2026, 4, 29, 10, 0)
    assert rows[0].end_ts == UTC(2026, 4, 29, 10, 5)
    assert rows[0].data["event_count"] == 1
    assert rows[0].data["device"] == "phone"


# ---------------------------------------------------------------------------
# Clustering — within-gap and beyond-gap
# ---------------------------------------------------------------------------


def test_two_events_within_gap_form_one_span() -> None:
    """Events at 10:00 and 10:05 (gap = 5m, ≤ gap_within_span 7m) →
    one span [10:00, 10:10) (last event + 5m fade)."""
    deriver = _StubFetcher([
        _evt(UTC(2026, 4, 29, 10, 0)),
        _evt(UTC(2026, 4, 29, 10, 5)),
    ])
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 9, 30), UTC(2026, 4, 29, 12, 0)
    )
    assert len(rows) == 1
    assert rows[0].start_ts == UTC(2026, 4, 29, 10, 0)
    assert rows[0].end_ts == UTC(2026, 4, 29, 10, 10)
    assert rows[0].data["event_count"] == 2


def test_two_events_beyond_gap_form_two_spans() -> None:
    """Events at 10:00 and 10:10 (gap = 10m, > 7m) → two spans."""
    deriver = _StubFetcher([
        _evt(UTC(2026, 4, 29, 10, 0)),
        _evt(UTC(2026, 4, 29, 10, 10)),
    ])
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 9, 30), UTC(2026, 4, 29, 12, 0)
    )
    assert len(rows) == 2
    assert rows[0].start_ts == UTC(2026, 4, 29, 10, 0)
    assert rows[0].end_ts == UTC(2026, 4, 29, 10, 5)
    assert rows[1].start_ts == UTC(2026, 4, 29, 10, 10)
    assert rows[1].end_ts == UTC(2026, 4, 29, 10, 15)


def test_mac_focus_session_does_not_fragment() -> None:
    """Mac coding session: events every 6m for 30m. With
    gap_within_span = 7m, all events stay in ONE span. Common-sense
    audit specifically called this out as a failure mode of a tighter
    gap_within_span value."""
    base = UTC(2026, 4, 29, 14, 0)
    events = [
        _evt(base + timedelta(minutes=6 * i), src="mac.system.window")
        for i in range(6)  # 0, 6, 12, 18, 24, 30
    ]
    deriver = _StubFetcher(events)
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 13, 30), UTC(2026, 4, 29, 15, 30)
    )
    assert len(rows) == 1
    assert rows[0].start_ts == UTC(2026, 4, 29, 14, 0)
    assert rows[0].end_ts == UTC(2026, 4, 29, 14, 35)  # 14:30 + 5m fade
    assert rows[0].data["event_count"] == 6


# ---------------------------------------------------------------------------
# Multi-source classification
# ---------------------------------------------------------------------------


def test_phone_only_span_classifies_as_phone() -> None:
    deriver = _StubFetcher([
        _evt(UTC(2026, 4, 29, 10, 0), "phone.system.unlocked"),
        _evt(UTC(2026, 4, 29, 10, 2), "phone.system.foreground"),
    ])
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 9, 30), UTC(2026, 4, 29, 12, 0)
    )
    assert rows[0].data["device"] == "phone"
    assert "phone.system.unlocked" in rows[0].data["sources"]
    assert "phone.system.foreground" in rows[0].data["sources"]


def test_mixed_phone_mac_span_classifies_as_both() -> None:
    """Phone + Mac events within span gap → device='both'."""
    deriver = _StubFetcher([
        _evt(UTC(2026, 4, 29, 14, 0), "mac.system.window"),
        _evt(UTC(2026, 4, 29, 14, 3), "phone.system.foreground"),
        _evt(UTC(2026, 4, 29, 14, 5), "mac.system.afk"),
    ])
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 13, 30), UTC(2026, 4, 29, 15, 0)
    )
    assert len(rows) == 1
    assert rows[0].data["device"] == "both"


# ---------------------------------------------------------------------------
# Lookback / pre-window skip
# ---------------------------------------------------------------------------


def test_span_starting_in_lookback_is_emitted_with_true_start() -> None:
    """Under OVERLAP_REPLACE: a span whose first event is in lookback
    (before window_start) but whose span extends into the window IS
    emitted, with its true start_ts. The framework's overlap-mode
    delete handles dedup against earlier ticks' identically-keyed rows."""
    deriver = _StubFetcher([
        _evt(UTC(2026, 4, 29, 9, 55)),  # before window_start (10:00)
        _evt(UTC(2026, 4, 29, 10, 1)),  # in window, within 7m of prev
        _evt(UTC(2026, 4, 29, 11, 0)),  # separate span entirely in window
    ])
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 10, 0), UTC(2026, 4, 29, 12, 0)
    )
    # Two spans: one bridging lookback→window, one purely in window.
    assert len(rows) == 2
    assert rows[0].start_ts == UTC(2026, 4, 29, 9, 55)
    assert rows[1].start_ts == UTC(2026, 4, 29, 11, 0)
    assert metrics["spans_skipped_pre_window"] == 0


def test_span_entirely_in_lookback_is_skipped() -> None:
    """A span whose entire (start, end) is before window_start has no
    overlap with the window — agent_api would reject it. Skip."""
    deriver = _StubFetcher([
        _evt(UTC(2026, 4, 29, 9, 30)),  # ends at 9:35 (5m fade), still pre-window
        _evt(UTC(2026, 4, 29, 11, 0)),  # in window
    ])
    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 10, 0), UTC(2026, 4, 29, 12, 0)
    )
    assert len(rows) == 1
    assert rows[0].start_ts == UTC(2026, 4, 29, 11, 0)
    assert metrics["spans_skipped_pre_window"] == 1


def test_span_end_capped_at_window_end() -> None:
    """A span whose last event is inside the window but whose
    trailing-fade extends past window_end → end_ts capped."""
    deriver = _StubFetcher([
        _evt(UTC(2026, 4, 29, 11, 58)),  # +5m fade = 12:03, past 12:00
    ])
    rows, _ = deriver.compute(
        None, UTC(2026, 4, 29, 10, 0), UTC(2026, 4, 29, 12, 0)
    )
    assert rows[0].end_ts == UTC(2026, 4, 29, 12, 0)


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_id_stable_across_replay() -> None:
    """Same first event → same id. Sub-microsecond jitter doesn't flip
    the id because the deterministic key truncates microseconds."""
    ts1 = UTC(2026, 4, 29, 10, 0, 30)
    ts2 = ts1.replace(microsecond=999_999)
    assert _deterministic_span_id(ts1) == _deterministic_span_id(ts2)
    # Different second → different id.
    assert _deterministic_span_id(ts1) != _deterministic_span_id(
        ts1 + timedelta(seconds=1)
    )


def test_replay_produces_identical_rows() -> None:
    """Two compute() calls on identical inputs → identical row ids
    (replace_derived_window UPSERT semantics rely on this)."""
    events = [
        _evt(UTC(2026, 4, 29, 10, 0)),
        _evt(UTC(2026, 4, 29, 10, 4)),
        _evt(UTC(2026, 4, 29, 11, 0)),
    ]
    d1 = _StubFetcher(events)
    d2 = _StubFetcher(events)
    rows1, _ = d1.compute(
        None, UTC(2026, 4, 29, 9, 30), UTC(2026, 4, 29, 12, 0)
    )
    rows2, _ = d2.compute(
        None, UTC(2026, 4, 29, 9, 30), UTC(2026, 4, 29, 12, 0)
    )
    assert [r.id for r in rows1] == [r.id for r in rows2]
    assert [r.start_ts for r in rows1] == [r.start_ts for r in rows2]
