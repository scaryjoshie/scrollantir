"""`project_chunk/v1` deriver.

For each `window_session/v1` span, look up the title in
`public.window_titles`. Cache hit → emit a project_chunk row tagged
with the cached project_slug + category. Cache miss → enqueue the
title in `public.classification_queue` for the LLM classifier job
(see scrollantir.agent.classifier_job) to resolve, and emit the
chunk with `project_slug=null, category='neutral'` for now. Next
tick after classification completes, the cache hit produces the
correct tag.

Output shape:
    data:       { project_slug: str | null,
                  category: 'work' | 'play' | 'neutral',
                  device, app, title, classified: bool }
    provenance: { inputs: ['window_session/v1'],
                  source_event_ids: [<window_session row id>],
                  model: str | null }

The chunk's [start_ts, end_ts] mirrors the window_session it derived
from — one chunk per session. We could collapse adjacent same-
project chunks into longer spans later, but that's a follow-up
iteration; for now keep it 1:1.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, UUID, uuid5

from . import register
from .base import DerivedRow, DeterministicDeriver, IdempotencyMode

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers.project_chunk")

SOURCE = "project_chunk/v1"


class ProjectChunkV1Deriver(DeterministicDeriver):
    SOURCE = SOURCE
    INPUTS = ("window_session/v1",)
    IDEMPOTENCY_MODE = IdempotencyMode.OVERLAP_REPLACE

    def compute(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> tuple[list[DerivedRow], dict[str, Any]]:
        sessions = self._fetch_sessions(conn, start, end)
        if not sessions:
            return [], {
                "sessions_total": 0, "cache_hits": 0,
                "cache_misses": 0, "queued_for_classification": 0,
            }

        # Bulk-fetch classifications for every distinct title in this
        # batch; misses get enqueued in one round trip.
        titles = sorted({s["title"] for s in sessions if s["title"]})
        cache = self._fetch_classifications(conn, titles)
        misses = [t for t in titles if t not in cache]
        if misses:
            self._enqueue_classifications(conn, misses)

        rows: list[DerivedRow] = []
        for sess in sessions:
            title = sess["title"]
            classification = cache.get(title) if title else None
            project_slug = classification["project_slug"] if classification else None
            category = classification["category"] if classification else "neutral"
            model = classification["model"] if classification else None
            rows.append(
                DerivedRow(
                    id=_chunk_id(sess["id"]),
                    source=self.SOURCE,
                    start_ts=sess["start_ts"],
                    end_ts=sess["end_ts"],
                    data={
                        "project_slug": project_slug,
                        "category": category,
                        "device": sess["device"],
                        "app": sess["app"],
                        "title": title,
                        "classified": classification is not None,
                    },
                    provenance={
                        "inputs": list(self.INPUTS),
                        "source_event_ids": [str(sess["id"])],
                        "model": model,
                    },
                )
            )
        return rows, {
            "sessions_total": len(sessions),
            "cache_hits": len(titles) - len(misses),
            "cache_misses": len(misses),
            "queued_for_classification": len(misses),
        }

    def _fetch_sessions(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> list[dict[str, Any]]:
        """Pull window_session/v1 rows whose span overlaps the window.
        Mirrors travel_leg's overlap-fetch pattern so a session that
        started in lookback gets a chunk row too."""
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, start_ts, end_ts,
                       data->>'device' AS device,
                       data->>'app'    AS app,
                       data->>'title'  AS title
                  FROM public.derived_events
                 WHERE source = 'window_session/v1'
                   AND start_ts <  %s
                   AND end_ts   >  %s
                 ORDER BY start_ts
                """,
                (end, start),
            )
            return [
                {
                    "id": row[0],
                    "start_ts": row[1],
                    "end_ts": row[2],
                    "device": row[3],
                    "app": row[4],
                    "title": row[5],
                }
                for row in cur.fetchall()
            ]

    def _fetch_classifications(
        self,
        conn: "psycopg.Connection",
        titles: list[str],
    ) -> dict[str, dict[str, Any]]:
        if not titles:
            return {}
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT title, project_slug, category, model
                  FROM public.window_titles
                 WHERE title = ANY(%s)
                """,
                (titles,),
            )
            return {
                row[0]: {
                    "project_slug": row[1],
                    "category": row[2],
                    "model": row[3],
                }
                for row in cur.fetchall()
            }

    def _enqueue_classifications(
        self,
        conn: "psycopg.Connection",
        titles: list[str],
    ) -> None:
        """Insert pending classifications. ON CONFLICT DO NOTHING so
        re-deriving the same window doesn't reset the retry counter
        on rows that are already queued."""
        if not titles:
            return
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO public.classification_queue (title)
                VALUES (%s)
                ON CONFLICT (title) DO NOTHING
                """,
                [(t,) for t in titles],
            )


def _chunk_id(window_session_id: UUID) -> UUID:
    """Stable id keyed on the source window_session id. One chunk per
    session; replays produce the same id."""
    return uuid5(NAMESPACE_URL, f"project_chunk/v1:{window_session_id}")


register(ProjectChunkV1Deriver())
