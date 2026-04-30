"""`user_active/v1` deriver — primitive activity-span detection.

Aggregates raw "user actually interacted" events (phone unlocks, app
foreground changes, Mac window changes, AFK transitions) into
contiguous *activity spans*. Each emitted row is one continuous
period of "user is using a device".

Why this is a primitive:

- Sleep detection wants the *gaps* between activity spans (silent
  runs ≥ N minutes long).
- The eventual /summary page wants total active-time per day.
- Top-apps charts want to clip per-app durations to active spans
  (so you're not credited for "using Slack" while you're asleep
  with Slack in the foreground).

Inputs explicitly EXCLUDE `phone.system.screen` because notifications
cause passive screen-on flashes that don't represent the user
actually doing anything. The remaining four sources only fire when
the user actively interacts.

Activity spans:

- Two events within `gap_within_span_min` (default 7m) of each
  other are part of the same span. 7m chosen to accommodate Mac
  deep-focus coding where keystroke gaps can run 6-8m.
- A span's `end_ts` extends `trailing_fade_min` (default 5m) past
  its last event — models "user is still active for a brief tail
  after their last interaction".
- A span's `start_ts` is the first event timestamp (NO leading
  fade — silence ends *exactly* when the user first interacts).

Lookback: fetches events from `[start - lookback_min, end)` and
skips emitting any span whose `first_event_ts < window_start`.
Mirrors place_visit's idempotency convention — earlier-tick rows
are already in the table; emitting them again would cause
spurious duplicates after `replace_derived_window`.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, UUID, uuid5

from . import register
from .base import DerivedRow, DeterministicDeriver

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers.user_active")

SOURCE = "user_active/v1"

_PHONE_PREFIX = "phone."
_MAC_PREFIX = "mac."


class UserActiveV1Deriver(DeterministicDeriver):
    """Cluster raw interaction events into contiguous activity spans."""

    SOURCE = SOURCE
    INPUTS = (
        "phone.system.unlocked",
        "phone.system.foreground",
        "mac.system.window",
        "mac.system.afk",
    )

    # Two events count as the same span if their timestamps are within
    # this many minutes of each other. Set to 7 (vs the more obvious 5)
    # so Mac deep-focus coding sessions — which can have 6-8m keystroke
    # gaps — don't fragment into a dozen small spans.
    gap_within_span_min: float = 7.0

    # Span end_ts = last event ts + this fade. Models "user is still
    # active for a brief tail after their last observable interaction".
    # Symmetric with gap_within_span: keeps the algorithm coherent
    # across "two close events" (one span) vs "two events with no
    # follow-up" (extends the implied active window).
    trailing_fade_min: float = 5.0

    # How far before window_start to fetch events from. A span whose
    # first event was at window_start - 2m would otherwise be invisible
    # to this run AND the previous run already emitted it — so we'd
    # skip emit (good). But on a cold start / backfill there's no
    # earlier run, and skipping leaves a permanent gap. 30m is
    # generous: bounded by the gap_within_span anyway, so anything
    # older than ~10m before window_start is its own earlier span.
    lookback_min: float = 30.0

    def compute(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> tuple[list[DerivedRow], dict[str, Any]]:
        fetch_start = start - timedelta(minutes=self.lookback_min)
        events = self._fetch_events(conn, fetch_start, end)

        gap_threshold = timedelta(minutes=self.gap_within_span_min)
        fade = timedelta(minutes=self.trailing_fade_min)

        # Cluster events into spans using the gap_within_span rule.
        # Each span = list of (ts, source, event_id) tuples.
        spans: list[list[tuple[datetime, str, UUID]]] = []
        current: list[tuple[datetime, str, UUID]] = []
        for ts, source, eid in events:
            if not current or ts - current[-1][0] <= gap_threshold:
                current.append((ts, source, eid))
            else:
                spans.append(current)
                current = [(ts, source, eid)]
        if current:
            spans.append(current)

        rows: list[DerivedRow] = []
        skipped_pre_window = 0
        skipped_pre_window_ids: list[str] = []
        for span in spans:
            first_ts = span[0][0]
            last_ts = span[-1][0]
            # Span start_ts = first event (no leading fade).
            span_start = first_ts
            # Trailing fade pads end. Capped at window end so we don't
            # emit a row whose end_ts pokes outside the deriver window.
            span_end = min(end, last_ts + fade)
            if span_start >= end:
                # Edge case: every event was outside the window.
                continue

            # Skip spans that started before window_start — an earlier
            # tick owns them. Without this, replace_derived_window
            # would not see (and not delete) the prior tick's row,
            # so we'd insert a duplicate.
            if span_start < start:
                skipped_pre_window += 1
                if len(skipped_pre_window_ids) < 5:
                    skipped_pre_window_ids.append(first_ts.isoformat())
                continue

            phone_evts = sum(
                1 for _, src, _ in span if src.startswith(_PHONE_PREFIX)
            )
            mac_evts = sum(
                1 for _, src, _ in span if src.startswith(_MAC_PREFIX)
            )
            if phone_evts and mac_evts:
                device = "both"
            elif mac_evts:
                device = "mac"
            else:
                device = "phone"

            sources_seen = sorted({src for _, src, _ in span})
            row_id = _deterministic_span_id(span_start)

            rows.append(
                DerivedRow(
                    id=row_id,
                    source=self.SOURCE,
                    start_ts=span_start,
                    end_ts=span_end,
                    data={
                        "device": device,
                        "event_count": len(span),
                        "sources": sources_seen,
                    },
                    provenance={
                        "inputs": list(self.INPUTS),
                        "source_event_ids": [str(eid) for _, _, eid in span],
                    },
                )
            )

        metrics = {
            "events_total": len(events),
            "spans_total": len(spans),
            "spans_emitted": len(rows),
            "spans_skipped_pre_window": skipped_pre_window,
            "skipped_first_ts_sample": skipped_pre_window_ids,
        }
        return rows, metrics

    def _fetch_events(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> list[tuple[datetime, str, UUID]]:
        """Returns `[(start_ts, source, id)]` for every qualifying event
        in the window, ordered ascending by `start_ts`."""
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT start_ts, source, id
                  FROM public.events
                 WHERE source = ANY(%s)
                   AND start_ts >= %s
                   AND start_ts <  %s
                 ORDER BY start_ts, id
                """,
                (list(self.INPUTS), start, end),
            )
            return [(row[0], row[1], row[2]) for row in cur.fetchall()]


def _deterministic_span_id(first_event_ts: datetime) -> UUID:
    """Stable id for a user_active span.

    Anchored on the first event's timestamp (rounded to second). The
    lookback window guarantees both replays see the same first event,
    so the id is reproducible.

    A re-derive of the same span produces the same id; sub-second
    jitter is collapsed by truncating microseconds.
    """
    key = (
        f"user_active/v1:"
        f"{first_event_ts.replace(microsecond=0).isoformat()}"
    )
    return uuid5(NAMESPACE_URL, key)


# Auto-register at import (mirrors place_visit / travel_leg pattern).
register(UserActiveV1Deriver())
