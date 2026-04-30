"""`window_session/v1` deriver tests.

Stub the DB fetch; exercise the clustering + title-change-splits-span
behavior + lookback skip via synthetic event streams.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from scrollantir.core.derivers.window_session import (
    WindowSessionV1Deriver,
    _WindowEvent,
)


def UTC(year: int, month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)


class _Stub(WindowSessionV1Deriver):
    def __init__(self, events: list[_WindowEvent]):
        self._stub = sorted(events, key=lambda e: (e.ts, str(e.event_id)))

    def _fetch_window_events(self, conn, start, end):  # type: ignore[override]
        fetch_start = start - timedelta(minutes=self.lookback_min)
        return [
            ev for ev in self._stub
            if fetch_start <= ev.ts < end
        ]


def _ev(ts: datetime, app: str, title: str, src: str = "mac.system.window") -> _WindowEvent:
    return _WindowEvent(ts=ts, source=src, app=app, title=title, event_id=uuid4())


def test_empty_emits_nothing() -> None:
    rows, m = _Stub([]).compute(
        None, UTC(2026, 4, 30, 10, 0), UTC(2026, 4, 30, 11, 0)
    )
    assert rows == []
    assert m["spans_total"] == 0


def test_consecutive_same_title_within_gap_one_span() -> None:
    """Two events on the same window title 5 min apart (≤ 7m gap)
    form ONE span. end_ts = last event + 1m fade."""
    rows, _ = _Stub([
        _ev(UTC(2026, 4, 30, 10, 0), "VS Code", "sleep.py — scrollantir"),
        _ev(UTC(2026, 4, 30, 10, 5), "VS Code", "sleep.py — scrollantir"),
    ]).compute(None, UTC(2026, 4, 30, 9, 0), UTC(2026, 4, 30, 11, 0))
    assert len(rows) == 1
    assert rows[0].start_ts == UTC(2026, 4, 30, 10, 0)
    assert rows[0].end_ts == UTC(2026, 4, 30, 10, 6)
    assert rows[0].data["title"] == "sleep.py — scrollantir"
    assert rows[0].data["event_count"] == 2


def test_title_change_splits_span() -> None:
    """A title change starts a new span even when the gap is small."""
    rows, _ = _Stub([
        _ev(UTC(2026, 4, 30, 10, 0), "VS Code", "sleep.py — scrollantir"),
        _ev(UTC(2026, 4, 30, 10, 1), "VS Code", "place_visit.py — scrollantir"),
    ]).compute(None, UTC(2026, 4, 30, 9, 0), UTC(2026, 4, 30, 11, 0))
    assert len(rows) == 2
    assert rows[0].data["title"] == "sleep.py — scrollantir"
    assert rows[1].data["title"] == "place_visit.py — scrollantir"
    assert rows[0].id != rows[1].id


def test_long_gap_splits_span_even_same_title() -> None:
    """Two events on the same title >7m apart → two spans (the user
    was elsewhere in between)."""
    rows, _ = _Stub([
        _ev(UTC(2026, 4, 30, 10, 0), "VS Code", "sleep.py — scrollantir"),
        _ev(UTC(2026, 4, 30, 10, 10), "VS Code", "sleep.py — scrollantir"),
    ]).compute(None, UTC(2026, 4, 30, 9, 0), UTC(2026, 4, 30, 11, 0))
    assert len(rows) == 2


def test_phone_foreground_emits_span() -> None:
    """phone.system.foreground events emit spans too. Title falls back
    to the app field since Android doesn't expose per-window titles."""
    rows, _ = _Stub([
        _ev(UTC(2026, 4, 30, 10, 0), "com.discord", "com.discord", "phone.system.foreground"),
        _ev(UTC(2026, 4, 30, 10, 2), "com.discord", "com.discord", "phone.system.foreground"),
    ]).compute(None, UTC(2026, 4, 30, 9, 0), UTC(2026, 4, 30, 11, 0))
    assert len(rows) == 1
    assert rows[0].data["device"] == "phone"
    assert rows[0].data["title"] == "com.discord"


def test_lookback_span_extends_into_window_is_emitted() -> None:
    """A foreground span that started in lookback but whose end_ts is
    IN window (because the user kept it foregrounded until the next
    change happened in-window) IS emitted. Span end = next-span start,
    not last_event + fade — so a window held for 90 min straddling
    lookback and window contributes its full extent.
    """
    rows, m = _Stub([
        _ev(UTC(2026, 4, 30, 9, 0), "VS Code", "old"),
        _ev(UTC(2026, 4, 30, 9, 2), "VS Code", "old"),
        _ev(UTC(2026, 4, 30, 10, 30), "VS Code", "in window"),
    ]).compute(
        None, UTC(2026, 4, 30, 10, 0), UTC(2026, 4, 30, 11, 0)
    )
    titles = [r.data["title"] for r in rows]
    assert titles == ["old", "in window"]
    # "old" span ends at 10:30 — the foreground transition is when
    # "old" stopped being active.
    assert rows[0].start_ts == UTC(2026, 4, 30, 9, 0)
    assert rows[0].end_ts == UTC(2026, 4, 30, 10, 30)
    assert m["spans_skipped_pre_window"] == 0


def test_lookback_only_span_with_no_successor_skipped() -> None:
    """A span entirely in lookback with NO in-window successor uses
    fade for its end_ts (last_event + 1m). If that's still before
    window_start, the span has no overlap and is skipped."""
    rows, m = _Stub([
        _ev(UTC(2026, 4, 30, 9, 30), "VS Code", "old"),
    ]).compute(
        None, UTC(2026, 4, 30, 10, 0), UTC(2026, 4, 30, 11, 0)
    )
    assert rows == []
    assert m["spans_skipped_pre_window"] == 1


def test_id_includes_title_for_disambiguation() -> None:
    """Two consecutive different-title spans starting in the same
    second mustn't collide on uuid5."""
    rows, _ = _Stub([
        _ev(UTC(2026, 4, 30, 10, 0, 0), "A", "alpha"),
        _ev(UTC(2026, 4, 30, 10, 0, 0), "B", "beta"),
    ]).compute(None, UTC(2026, 4, 30, 9, 0), UTC(2026, 4, 30, 11, 0))
    # Title sort within tie isn't deterministic on the input; just
    # confirm both rows exist with distinct ids.
    assert len(rows) == 2
    assert rows[0].id != rows[1].id
