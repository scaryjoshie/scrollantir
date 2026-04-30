"""`sleep/v1` deriver.

Detects sleep periods (and short naps) from gaps in `user_active/v1`
spans. Reads from `derived_events` rather than raw events — sleep
inherits the activity-source whitelist + clustering semantics from
the user_active primitive (which is reusable for summary stats and
top-apps masking later).

Per-day output:

  - Up to ONE row with `kind = 'night'` — the longest qualifying
    silent run that's both ≥ night_floor (180 min) AND ends in
    [04:00, 14:00) local time. This sets /today's day boundary.
  - Up to N rows (default 2) with `kind = 'nap'` — the longest
    *other* silent runs ≥ nap_floor (90 min). Naps render as
    Moments inside the day timeline; they don't shift the boundary.

Why two floors: per-user spec, anything < 90 min isn't sleep at
all; common-sense audit pushed back that 90 min is more nap-than-
sleep, so 'night' (the day-boundary row) requires ≥ 180 min. A
half-hearted 100-min "night" doesn't get to define when the day
started — it shows up as a nap and the dashboard falls back to
04:00.

Why morning-hours filter only on 'night': lets afternoon naps
qualify as naps without misclassifying a long evening movie as
"the day's main sleep". The cap (1 night + 2 naps) prevents the
day from filling up with marginal silent runs.

Brief mid-sleep activity ≤ max_interruption_min (5 min) is
absorbed via silent-run merging — bathroom break + glance at
phone shouldn't split an 8h sleep into two 4h runs. The 5-min
tolerance is intentionally tighter than the user_active fade
(also 5 min); together they accommodate roughly a 10-min real
mid-night activity gap before splitting.

Determinism: id keyed on `{wake_local_date, kind, rank}` rather
than sleep_start timestamp. Boundary jitter (a single new event
shifting silent_run start by seconds) wouldn't change the id —
just the data — so `replace_derived_window` UPSERT semantics
hold. Naps in the same day get rank 0..N by start_ts.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, UUID, uuid5

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover — runtime is Python 3.9+
    from backports.zoneinfo import ZoneInfo  # type: ignore

from . import register
from .base import DerivedRow, DeterministicDeriver

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers.sleep")

SOURCE = "sleep/v1"


class SleepV1Deriver(DeterministicDeriver):
    """Detect sleep + naps from gaps in user_active/v1 spans."""

    SOURCE = SOURCE
    INPUTS = ("user_active/v1",)

    # Hard floor for ANY sleep candidate. Below this we don't emit at
    # all — per user, "not sleep if less than 90 min".
    nap_floor_min: float = 90.0

    # Higher floor for `kind='night'` (the row /today uses to set the
    # day boundary). Common-sense audit was correct that a 90-min
    # silence is nap-territory; anointing it as "the night's sleep"
    # would over-shift the day boundary in cases the user wouldn't
    # call sleep at all.
    night_floor_min: float = 180.0

    # Brief mid-night activity tolerance — silent runs separated by ≤
    # this much real activity collapse into one with `disrupted_count`
    # incremented. 5 min is intentionally tight: the user_active
    # primitive already extends spans 5 min past their last event, so
    # the effective tolerance for "real activity" between two silent
    # runs is closer to ~10 min once you account for the trailing fade.
    max_interruption_min: float = 5.0

    # Local-time window for `kind='night'` qualification. A long sleep
    # ending in this range is the night; one ending outside is a nap.
    # 04-14 covers normal early/late risers; if the user pulls an
    # all-nighter and crashes 4 PM → 9 PM, that 5h silence ends at
    # 21:00 (outside) and is correctly classified as a nap.
    morning_wake_start_local: int = 4
    morning_wake_end_local: int = 14

    # At most this many `kind='nap'` rows per local day (longest by
    # duration). The "primary" night row is independent of this cap.
    max_naps_per_day: int = 2

    # Hardcoded for v1 (single user). DST-aware via zoneinfo.
    local_tz_name: str = "America/Chicago"

    # When fetching user_active rows from `derived_events`, look this
    # far past `window_start`. Captures user_active rows emitted by
    # earlier ticks whose `start_ts` is now slightly before window_start
    # (the rolling window has advanced). Without this, a silence whose
    # bracketing previous active span starts in the just-prior period
    # is invisible — sleep would see only the wake span and treat the
    # silence as leading (dropped). 12h is wide enough to bracket any
    # plausible activity-span first event AND any silence that started
    # within the previous tick's window. Sleep onsets BEFORE
    # `window_start` are still skip-emitted; lookback only restores the
    # visibility needed to compute the run correctly.
    fetch_lookback_hours: float = 12.0

    def compute(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> tuple[list[DerivedRow], dict[str, Any]]:
        active_spans = self._fetch_active_spans(conn, start, end)
        silent = _silent_runs(active_spans)
        merged, disruptions = _merge_brief_interruptions(
            silent, timedelta(minutes=self.max_interruption_min)
        )

        nap_floor = timedelta(minutes=self.nap_floor_min)
        long_runs = [(s, e) for (s, e) in merged if e - s >= nap_floor]

        metrics: dict[str, Any] = {
            "active_spans_total": len(active_spans),
            "silent_runs_total": len(silent),
            "silent_runs_long": len(long_runs),
            "rows_emitted": 0,
            "nights_emitted": 0,
            "naps_emitted": 0,
        }

        if not long_runs:
            return [], metrics

        tz = ZoneInfo(self.local_tz_name)
        # Group candidates by `wake_local_date`. Each group classifies
        # at most one `night` (longest, also satisfying night_floor +
        # morning-hours) plus up to `max_naps_per_day` naps.
        by_day: dict[str, list[tuple[datetime, datetime]]] = {}
        for s, e in long_runs:
            wake_date = e.astimezone(tz).date().isoformat()
            by_day.setdefault(wake_date, []).append((s, e))

        rows: list[DerivedRow] = []
        for wake_date, group in by_day.items():
            # Skip rows whose wake_ts < window_start — an earlier tick
            # owns them. Without this, the rolling-window deriver would
            # spuriously re-emit yesterday's sleep every tick.
            in_window = [
                (s, e) for (s, e) in group
                if e >= start  # wake_ts inside / after start
                and s >= start  # AND silence starts inside window too
            ]
            if not in_window:
                continue

            in_window.sort(key=lambda r: (r[1] - r[0]), reverse=True)
            night = self._pick_night(in_window, tz)
            naps = [r for r in in_window if r != night]
            naps.sort(key=lambda r: (r[1] - r[0]), reverse=True)
            naps = naps[: self.max_naps_per_day]
            naps.sort(key=lambda r: r[0])  # render in chronological order

            if night is not None:
                rows.append(
                    self._build_row(
                        sleep_start=night[0],
                        wake_ts=night[1],
                        kind="night",
                        rank=0,
                        wake_local_date=wake_date,
                        disrupted=disruptions.get(night, 0),
                        all_in_day=in_window,
                        tz=tz,
                    )
                )
                metrics["nights_emitted"] += 1

            for rank, nap in enumerate(naps):
                rows.append(
                    self._build_row(
                        sleep_start=nap[0],
                        wake_ts=nap[1],
                        kind="nap",
                        rank=rank,
                        wake_local_date=wake_date,
                        disrupted=disruptions.get(nap, 0),
                        all_in_day=in_window,
                        tz=tz,
                    )
                )
                metrics["naps_emitted"] += 1

        metrics["rows_emitted"] = len(rows)
        return rows, metrics

    def _pick_night(
        self,
        sorted_runs: list[tuple[datetime, datetime]],
        tz: ZoneInfo,
    ) -> tuple[datetime, datetime] | None:
        """The day's `kind='night'` candidate, or None if no run
        qualifies. Walks runs in DESC duration order and returns the
        first one that's ≥ night_floor AND ends in morning-hours
        local. Otherwise → no night for this day; everything's a nap."""
        night_floor = timedelta(minutes=self.night_floor_min)
        for s, e in sorted_runs:
            if (e - s) < night_floor:
                continue
            wake_local_hour = e.astimezone(tz).hour
            if (
                self.morning_wake_start_local
                <= wake_local_hour
                < self.morning_wake_end_local
            ):
                return (s, e)
        return None

    def _build_row(
        self,
        *,
        sleep_start: datetime,
        wake_ts: datetime,
        kind: str,
        rank: int,
        wake_local_date: str,
        disrupted: int,
        all_in_day: list[tuple[datetime, datetime]],
        tz: ZoneInfo,
    ) -> DerivedRow:
        # Stable id: same (date, kind, rank) → same uuid, even if the
        # underlying boundaries shift by seconds across replays.
        row_id = uuid5(
            NAMESPACE_URL,
            f"sleep/v1:{wake_local_date}:{kind}:{rank}",
        )
        # Confidence: this run's duration relative to the next-largest
        # run in the same day-group. 1.0 if dominant. < 1.0 if a
        # competitor is comparably long.
        durations = sorted(
            [(e - s).total_seconds() for s, e in all_in_day],
            reverse=True,
        )
        my_dur = (wake_ts - sleep_start).total_seconds()
        if len(durations) <= 1:
            confidence = 1.0
        else:
            others = [d for d in durations if d != my_dur]
            runner_up = max(others) if others else 0
            confidence = (
                1.0 if runner_up <= 0
                else min(1.0, my_dur / runner_up / 2.0)
            )
        return DerivedRow(
            id=row_id,
            source=self.SOURCE,
            start_ts=sleep_start,
            end_ts=wake_ts,
            data={
                "kind": kind,
                "confidence": round(confidence, 3),
                "wake_local_date": wake_local_date,
            },
            provenance={
                "inputs": list(self.INPUTS),
                # Sleep is computed from active-span rows; the
                # `source_event_ids` here would be a list of
                # user_active/v1 row ids that bracket the silence.
                # To avoid pulling them just for provenance, we
                # leave this empty and rely on (start_ts, end_ts)
                # to pivot through user_active rows during debugging.
                # Schema CHECK accepts empty arrays.
                "source_event_ids": [],
                "disrupted_count": disrupted,
                "duration_minutes": round(
                    (wake_ts - sleep_start).total_seconds() / 60.0, 1
                ),
                "wake_local_time": wake_ts.astimezone(tz).strftime(
                    "%H:%M:%S"
                ),
                "rank": rank,
            },
        )

    def _fetch_active_spans(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> list[tuple[datetime, datetime]]:
        """Active spans whose start_ts is in `[start - lookback, end)`.

        Lookback is critical: a previous tick's user_active row may have
        `start_ts` slightly before this tick's `window_start`, and
        `replace_derived_window` doesn't delete rows outside [start,
        end), so those older rows persist in derived_events. Without
        lookback, sleep's first visible span would be window_start +
        whatever, and any silent run rooted in the just-prior active
        span would be invisible (treated as leading silence and
        dropped by the interior-only `_silent_runs`).

        Reads from `public.derived_events` directly (rather than the
        `v_user_active` view) — derivers consume canonical rows; views
        are for the dashboard.
        """
        fetch_start = start - timedelta(hours=self.fetch_lookback_hours)
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT start_ts, end_ts
                  FROM public.derived_events
                 WHERE source = 'user_active/v1'
                   AND start_ts >= %s
                   AND start_ts <  %s
                 ORDER BY start_ts
                """,
                (fetch_start, end),
            )
            return [(row[0], row[1]) for row in cur.fetchall()]


# ---------------------------------------------------------------------------
# Pure helpers (no DB)
# ---------------------------------------------------------------------------


def _silent_runs(
    active_spans: list[tuple[datetime, datetime]],
) -> list[tuple[datetime, datetime]]:
    """Interior silent runs between consecutive active spans.

    Each returned run is `(prev_span.end, next_span.start)`. NO
    clamping to a window — clamping would corrupt onset reporting.
    The deriver's skip-pre-window rule (silent_run.start < window_start
    → don't emit) handles the "this run was already emitted by an
    earlier tick" case correctly only when the silent_run reflects the
    *true* onset, not a window-clamped one.

    Excludes leading silence (before the first active span) and
    trailing silence (after the last). Those are unobserved time
    (window opened pre-activity or hasn't closed yet) — including
    them would let the brief-interruption merger fold the user's
    normal pre-sleep evening into the sleep span.
    """
    runs: list[tuple[datetime, datetime]] = []
    for i in range(len(active_spans) - 1):
        s = active_spans[i][1]
        e = active_spans[i + 1][0]
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
    """Merge two consecutive silent runs into one if the activity
    between them lasted ≤ `max_interruption`.

    The 'gap' between two silent runs (the activity span between them)
    has duration `next.start - prev.end`. If that's small, we treat
    it as a brief mid-night wake and absorb it.

    Returns: (merged_runs, {merged_run -> disrupted_count}).
    """
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


# Auto-register at import (mirrors place_visit / travel_leg pattern).
register(SleepV1Deriver())
