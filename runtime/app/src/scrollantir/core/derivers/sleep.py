"""`sleep/v1` deriver.

Detects overnight sleep from device-silence patterns. Inputs are
event timestamps from the phone (foreground app changes, screen
state, lock/unlock) and the Mac (AFK transitions, window changes).
A minute the user is "active" is one that has at least one event
within a small forward window; everything else is "silent".

Algorithm (deterministic):

    events ─▶ active spans ─▶ silent runs (the gaps)
                              ─▶ merge across brief interruptions
                              ─▶ filter to runs ≥ min_sleep_hours
                              ─▶ keep runs whose END falls in
                                 "morning hours" (local time)
                              ─▶ emit one sleep/v1 row per qualifying
                                 run

Why "ends in morning hours": separates sleep from naps. A 4h silence
ending at 19:00 local is a nap; a 4h silence ending at 07:00 is sleep.

Why "merge across brief interruptions": a 4 AM bathroom break (1
unlock, 30s of activity) shouldn't split an 8h sleep into two 4h
runs neither of which qualifies.

Confidence: 1.0 when there's a clear winner, lower when multiple
runs compete. Below `min_confidence_to_emit` → don't emit (caller
falls back to the 04:00 day boundary). The LLM-uncertain branch
described in `docs/data-model.md` is deferred to a v2 — this v1
ships purely deterministic.

Each row's `[start_ts, end_ts]` is the sleep span; `data.confidence`
+ `provenance.disrupted_count` carry audit info. Deterministic id
keys on the wake date (one row per "morning of waking up") so
re-derivation is idempotent.
"""

from __future__ import annotations

import logging
from datetime import datetime, time, timedelta
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, UUID, uuid5

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover — Python < 3.9 not supported by runtime
    from backports.zoneinfo import ZoneInfo  # type: ignore

from . import register
from .base import DerivedRow, DeterministicDeriver

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers.sleep")

SOURCE = "sleep/v1"


class SleepV1Deriver(DeterministicDeriver):
    """Deterministic sleep detection over device-silence."""

    SOURCE = SOURCE
    INPUTS = (
        "phone.system.unlocked",
        "phone.system.screen",
        "phone.system.foreground",
        "mac.system.afk",
        "mac.system.window",
    )

    # Each event marks the user "active" for this many minutes
    # forward. Phone foreground events fire on app changes, so a
    # session of one app produces one event; the forward window
    # stretches that single event into a believable activity span.
    active_duration_min: float = 5.0

    # Brief interruption tolerance — a silent run interrupted by less
    # than this much activity (think bathroom break + glance at phone)
    # is treated as one continuous sleep, with `disrupted_count`
    # incremented per absorbed interruption.
    max_interruption_min: float = 15.0

    # Minimum silent-run duration to qualify as sleep at all. 4h is
    # generous enough to catch short nights, tight enough to reject
    # most naps.
    min_sleep_hours: float = 4.0

    # Wake time must land in this local-time window. Cuts off naps
    # whose end falls in the afternoon/evening. Hours are 24h, local.
    morning_hours_start_local: int = 4
    morning_hours_end_local: int = 14

    # Hardcoded for v1 (single user). DST-aware via zoneinfo, no need
    # for runtime config until we have multi-user.
    local_tz_name: str = "America/Chicago"

    # Ratio test for confidence scoring when multiple competing runs
    # exist. If the longest is ≥ 2× the runner-up duration, we're
    # confident; ≥ 1.5× → medium; otherwise low. Below
    # `min_confidence_to_emit`, the row is suppressed and the dashboard
    # falls back to its default (4 AM) day boundary.
    min_confidence_to_emit: float = 0.6

    def compute(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> tuple[list[DerivedRow], dict[str, Any]]:
        events = self._fetch_event_timestamps(conn, start, end)
        active = _active_spans(
            events, timedelta(minutes=self.active_duration_min)
        )
        silent = _silent_runs(active, start, end)
        merged, disruptions_by_run = _merge_brief_interruptions(
            silent, timedelta(minutes=self.max_interruption_min)
        )

        min_dur = timedelta(hours=self.min_sleep_hours)
        long_runs = [r for r in merged if r[1] - r[0] >= min_dur]

        # Morning-hours filter on wake-time: a 5h silence ending at
        # 19:00 is a nap, not sleep. Compare in local TZ.
        tz = ZoneInfo(self.local_tz_name)
        candidates = [
            (s, e) for (s, e) in long_runs
            if self.morning_hours_start_local
            <= e.astimezone(tz).hour
            < self.morning_hours_end_local
        ]

        metrics: dict[str, Any] = {
            "events_total": len(events),
            "silent_runs_total": len(silent),
            "silent_runs_long": len(long_runs),
            "candidates_in_morning": len(candidates),
        }

        if not candidates:
            return [], metrics

        # Score confidence per candidate against runner-up duration.
        durations = sorted(
            [(e - s).total_seconds() for s, e in long_runs], reverse=True
        )
        rows: list[DerivedRow] = []
        for sleep_start, wake_ts in candidates:
            this_dur = (wake_ts - sleep_start).total_seconds()
            confidence = _score_confidence(this_dur, durations)
            if confidence < self.min_confidence_to_emit:
                continue
            disrupted = disruptions_by_run.get((sleep_start, wake_ts), 0)
            row = self._build_row(
                sleep_start=sleep_start,
                wake_ts=wake_ts,
                confidence=confidence,
                disrupted_count=disrupted,
                tz=tz,
            )
            rows.append(row)

        metrics["rows_emitted"] = len(rows)
        return rows, metrics

    def _fetch_event_timestamps(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> list[datetime]:
        """Fetch start_ts of every relevant event in [start, end),
        sorted ascending. Sources merged into one stream — we only
        care that *something* happened, not which device."""
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT start_ts
                  FROM public.events
                 WHERE source = ANY(%s)
                   AND start_ts >= %s
                   AND start_ts <  %s
                 ORDER BY start_ts
                """,
                (list(self.INPUTS), start, end),
            )
            return [row[0] for row in cur.fetchall()]

    def _build_row(
        self,
        *,
        sleep_start: datetime,
        wake_ts: datetime,
        confidence: float,
        disrupted_count: int,
        tz: ZoneInfo,
    ) -> DerivedRow:
        wake_local_date = wake_ts.astimezone(tz).date().isoformat()
        row_id = uuid5(NAMESPACE_URL, f"sleep/v1:{wake_local_date}")
        return DerivedRow(
            id=row_id,
            source=self.SOURCE,
            start_ts=sleep_start,
            end_ts=wake_ts,
            data={
                "confidence": round(confidence, 3),
                # Wake date in user's local time — lets the dashboard
                # filter "last night's sleep" without re-doing TZ math.
                "wake_local_date": wake_local_date,
            },
            provenance={
                "inputs": list(self.INPUTS),
                # Sleep is computed from a population of events; we
                # don't carry per-event ids (would balloon under a
                # 7h+ silence with bracketing activity). Empty list is
                # acceptable per the schema CHECK (`array_length` not
                # required to be > 0).
                "source_event_ids": [],
                "disrupted_count": disrupted_count,
                "duration_hours": round(
                    (wake_ts - sleep_start).total_seconds() / 3600.0, 2
                ),
                "wake_local_time": wake_ts.astimezone(tz).strftime(
                    "%H:%M:%S"
                ),
            },
        )


# ---------------------------------------------------------------------------
# Algorithm helpers (pure, no DB)
# ---------------------------------------------------------------------------


def _active_spans(
    events: list[datetime],
    active_duration: timedelta,
) -> list[tuple[datetime, datetime]]:
    """Each event contributes a forward `active_duration` span; merge
    overlapping spans. Returns sorted, non-overlapping `[(start, end)]`."""
    if not events:
        return []
    spans = sorted([(e, e + active_duration) for e in events])
    out = [spans[0]]
    for s, e in spans[1:]:
        last_s, last_e = out[-1]
        if s <= last_e:
            if e > last_e:
                out[-1] = (last_s, e)
        else:
            out.append((s, e))
    return out


def _silent_runs(
    active_spans: list[tuple[datetime, datetime]],
    window_start: datetime,
    window_end: datetime,
) -> list[tuple[datetime, datetime]]:
    """Interior silent runs — gaps between CONSECUTIVE active spans,
    clipped to `[window_start, window_end)`.

    Critically, this does NOT include the silence before the first
    active span or after the last. Those are unobserved time
    (window opened before the user touched any device, or window
    closed before the user touched again), not sleep candidates.
    Including them would let the brief-interruption merger fold
    the user's normal pre-sleep evening into the sleep span, badly
    over-counting duration and shifting sleep_start_ts earlier than
    it should be.

    Each returned `(silent_start, silent_end)` is bracketed by
    activity on both sides — exactly what we want for sleep
    detection.
    """
    runs: list[tuple[datetime, datetime]] = []
    for i in range(len(active_spans) - 1):
        s = max(window_start, active_spans[i][1])
        e = min(window_end, active_spans[i + 1][0])
        if s < e:
            runs.append((s, e))
    return runs


def _merge_brief_interruptions(
    silent_runs: list[tuple[datetime, datetime]],
    max_interruption: timedelta,
) -> tuple[
    list[tuple[datetime, datetime]],
    dict[tuple[datetime, datetime], int],
]:
    """Two consecutive silent runs separated by an activity gap ≤
    `max_interruption` are merged into one (a brief mid-night wake).
    Returns the merged runs PLUS a `{run -> disrupted_count}` map so
    the deriver can record `disrupted_count` in provenance."""
    if not silent_runs:
        return [], {}
    out: list[tuple[datetime, datetime]] = [silent_runs[0]]
    disruptions: list[int] = [0]
    for s, e in silent_runs[1:]:
        gap = s - out[-1][1]
        if gap <= max_interruption:
            out[-1] = (out[-1][0], e)
            disruptions[-1] += 1
        else:
            out.append((s, e))
            disruptions.append(0)
    by_run = {run: disruptions[i] for i, run in enumerate(out)}
    return out, by_run


def _score_confidence(
    candidate_dur_s: float,
    all_long_durations_s: list[float],
) -> float:
    """Confidence = how dominant this run is over runner-up.

    - Sole qualifying run → 1.0
    - ≥ 2× runner-up      → 1.0
    - ≥ 1.5× runner-up    → 0.85
    - ≥ 1.2× runner-up    → 0.7
    - else                → 0.5  (likely competing nap or partial sleep)
    """
    if len(all_long_durations_s) <= 1:
        return 1.0
    others = [d for d in all_long_durations_s if d != candidate_dur_s]
    if not others:
        # Multiple runs all of identical duration — suspicious; lower.
        return 0.6
    runner_up = max(others)
    if runner_up <= 0:
        return 1.0
    ratio = candidate_dur_s / runner_up
    if ratio >= 2.0:
        return 1.0
    if ratio >= 1.5:
        return 0.85
    if ratio >= 1.2:
        return 0.7
    return 0.5


# Auto-register at import (mirrors place_visit / travel_leg pattern).
register(SleepV1Deriver())
