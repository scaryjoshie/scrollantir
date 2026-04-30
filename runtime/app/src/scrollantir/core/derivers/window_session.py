"""`window_session/v1` deriver — primitive per-window-title spans.

Aggregates consecutive `mac.system.window` and
`phone.system.foreground` events into per-window spans. Each emitted
row is "user was on this window/app for X minutes."

Why this is a primitive separate from user_active:
  - user_active answers "was the user at the device at all"
  - window_session answers "what specific window/tab were they on"
  - both are useful; project_chunk consumes window_session and
    summary stats can consume both.

Span boundaries: a new span starts whenever the window TITLE changes
(or the time gap exceeds gap_within_span_min). Two consecutive events
on the same title within ~7 min merge into one span. The trailing
fade extends `end_ts` 1 minute past the last event — narrower than
user_active's 5 min because window-change events are denser, so
shorter fade gives more accurate boundaries.

Inputs explicitly EXCLUDE `phone.system.unlocked` and `phone.system.
screen` because they don't carry a window title.

Output `data` shape:
    { device: 'phone' | 'mac',
      app:    str,            -- e.g. 'com.discord' / 'Visual Studio Code'
      title:  str,            -- e.g. 'sleep.py — scrollantir'
      event_count: int }

Determinism: id = uuid5("window_session/v1:{first_event_ts_iso}:{title}").
Title is part of the key so two consecutive different-title spans
starting at the same second don't collide.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, UUID, uuid5

from . import register
from .base import DerivedRow, DeterministicDeriver, IdempotencyMode

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers.window_session")

SOURCE = "window_session/v1"


@dataclass(frozen=True)
class _WindowEvent:
    ts: datetime
    source: str          # 'mac.system.window' | 'phone.system.foreground'
    app: str             # bundle id / app name (from data->>'app')
    title: str           # window title or app foreground (from data->>'title' or 'app')
    event_id: UUID


class WindowSessionV1Deriver(DeterministicDeriver):
    SOURCE = SOURCE
    INPUTS = ("mac.system.window", "phone.system.foreground")
    IDEMPOTENCY_MODE = IdempotencyMode.OVERLAP_REPLACE

    # Two events on the same title with a Δt ≤ this many minutes are
    # the same span. Longer gap → new span (the user was elsewhere
    # in between, even if they returned to the same title).
    gap_within_span_min: float = 7.0

    # Span end_ts = last event ts + this trailing fade. Tighter than
    # user_active's 5 min because window events fire on every change,
    # so the "last seen on this window" → "left this window" boundary
    # is sharper.
    trailing_fade_min: float = 1.0

    # Fetch this far before window_start to capture spans that began
    # before the tick window. Mirrors the lookback pattern in
    # user_active.
    lookback_min: float = 30.0

    def compute(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> tuple[list[DerivedRow], dict[str, Any]]:
        fetch_start = start - timedelta(minutes=self.lookback_min)
        events = self._fetch_window_events(conn, fetch_start, end)

        gap_threshold = timedelta(minutes=self.gap_within_span_min)
        fade = timedelta(minutes=self.trailing_fade_min)

        # Cluster events. A span continues while events are within
        # gap_threshold AND on the same title; a new span starts on
        # title change OR gap break.
        spans: list[list[_WindowEvent]] = []
        current: list[_WindowEvent] = []
        for ev in events:
            if (
                current
                and ev.title == current[-1].title
                and (ev.ts - current[-1].ts) <= gap_threshold
            ):
                current.append(ev)
            else:
                if current:
                    spans.append(current)
                current = [ev]
        if current:
            spans.append(current)

        rows: list[DerivedRow] = []
        skipped = 0
        for i, span in enumerate(spans):
            first = span[0]
            last = span[-1]
            span_start = first.ts
            # A foreground window is active from when it gains focus
            # until ANOTHER window takes focus. Span end = NEXT span's
            # start (not last_event + fade) so chunks don't overlap.
            # Using fade for non-final spans created an overlap of
            # `fade − inter-event-gap` between every pair of adjacent
            # spans — chunks summed to more than wall-clock duration.
            # Fade only applies to the LAST span (no successor; we
            # don't yet know when this window stopped being active).
            if i + 1 < len(spans):
                span_end = min(end, spans[i + 1][0].ts)
            else:
                span_end = min(end, last.ts + fade)
            if span_start >= end:
                continue
            # Drop spans entirely in lookback (no overlap with window).
            if span_end <= start:
                skipped += 1
                continue
            rows.append(
                DerivedRow(
                    id=_session_id(span_start, first.title),
                    source=self.SOURCE,
                    start_ts=span_start,
                    end_ts=span_end,
                    data={
                        "device": "mac" if first.source.startswith("mac.") else "phone",
                        "app": first.app,
                        "title": first.title,
                        "event_count": len(span),
                    },
                    provenance={
                        "inputs": list(self.INPUTS),
                        "source_event_ids": [str(ev.event_id) for ev in span],
                    },
                )
            )

        metrics = {
            "events_total": len(events),
            "spans_total": len(spans),
            "spans_emitted": len(rows),
            "spans_skipped_pre_window": skipped,
        }
        return rows, metrics

    def _fetch_window_events(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> list[_WindowEvent]:
        """Pull window/foreground events with their app + title.

        For mac.system.window, `data` carries `{app, title}` — title
        is the window title (e.g. 'sleep.py — scrollantir').

        For phone.system.foreground, Android-side `UsageStatsPoller`
        emits `{app, app_label}` — `app` is the raw package id (e.g.
        `com.google.android.apps.messaging`), `app_label` is the
        user-facing display name from `PackageManager.getApplicationLabel`
        ("Messages"). The deriver picks `app_label` first because raw
        package ids are unreadable in the dashboard and produce
        worse-classified rows (the LLM has to guess what
        `com.google.android.apps.nexuslauncher` means).

        Pre-app-label rows (events before that field shipped) fall
        through to `app` so the deriver still emits SOMETHING for them.
        """
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, start_ts, source,
                       COALESCE(data->>'app', '') AS app,
                       -- NULLIF before COALESCE: PostgreSQL's COALESCE
                       -- treats '' as a present value, so a mac event
                       -- with title='' (e.g. System Settings) would
                       -- bypass the fallthrough and emit empty-title
                       -- chunks. NULLIF coerces empty → NULL so the
                       -- chain reaches app_label / app properly.
                       COALESCE(
                         NULLIF(data->>'title', ''),
                         NULLIF(data->>'app_label', ''),
                         NULLIF(data->>'app', ''),
                         ''
                       ) AS title
                  FROM public.events
                 WHERE source = ANY(%s)
                   AND start_ts >= %s
                   AND start_ts <  %s
                 ORDER BY start_ts, id
                """,
                (list(self.INPUTS), start, end),
            )
            return [
                _WindowEvent(
                    ts=row[1],
                    source=row[2],
                    app=row[3],
                    title=row[4],
                    event_id=row[0],
                )
                for row in cur.fetchall()
            ]


def _session_id(first_ts: datetime, title: str) -> UUID:
    """Stable id for a window session.

    Keeps microseconds in the key. Two same-title spans within the
    same second is a real case (rapid title-flicker between two
    apps interleaved by a third within < 1s), and rounding to
    seconds collides their ids. Source events have stable full-
    precision timestamps so replays still produce identical ids.
    """
    key = f"window_session/v1:{first_ts.isoformat()}:{title}"
    return uuid5(NAMESPACE_URL, key)


register(WindowSessionV1Deriver())
