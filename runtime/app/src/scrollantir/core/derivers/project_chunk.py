"""`project_chunk/v1` deriver.

For each `window_session/v1` span, build a CONTEXT TUPLE — device,
app, zen browser container, browser url host, title — and look up
the resulting `context_key` in `public.window_titles`. Cache hit →
emit a project_chunk row tagged with the cached project_slug +
category. Cache miss → enqueue (context_key, context) in
`public.classification_queue` for the LLM classifier job to resolve
(see scrollantir.agent.classifier_job), and emit the chunk with
`project_slug=null, category='neutral'` for now. Next tick after
classification completes, the cache hit produces the correct tag.

Why context-keying (Phase D): a bare title like "Notes" is
ambiguous — the same string could be Apple Notes / a Zen tab on
the Work container / a tab on the Personal container. Hashing the
full context tuple lets the classifier give different answers for
each case, and lets the cache hit/miss respect those differences.

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

import hashlib
import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse
from uuid import NAMESPACE_URL, UUID, uuid5

from . import register
from .base import DerivedRow, DeterministicDeriver, IdempotencyMode

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers.project_chunk")

SOURCE = "project_chunk/v1"

# Mac browser apps for which we look up an overlapping tab event to
# get url_host + zen_container. Currently just Zen (the user's only
# browser). Listed explicitly so a future Safari/Chrome session
# without a corresponding tab-emitter doesn't silently miss context.
_BROWSER_APPS: frozenset[str] = frozenset({"Zen"})

# How far back to look for a tab event when assembling browser
# context. The tracker emits a tab event on each tab change; a
# window_session that started within 5s of the most recent tab event
# is overwhelmingly the browsing of THAT tab. Tighter than that and
# we'd miss tabs whose emit lagged the window-focus event by a
# fraction of a second.
_TAB_LOOKBACK_S: int = 5


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

        # Build a context for each session, then hash to a context_key.
        # Cache lookup is by context_key, not title — so identical
        # titles in different containers / on different devices land
        # in different rows.
        sess_contexts: list[tuple[dict[str, Any], dict[str, Any], str]] = []
        for sess in sessions:
            context = self._build_context(conn, sess)
            context_key = _context_key(context)
            sess_contexts.append((sess, context, context_key))

        unique_keys = sorted({ck for _, _, ck in sess_contexts})
        cache = self._fetch_classifications_by_key(conn, unique_keys)
        misses = [
            (ck, ctx)
            for _, ctx, ck in sess_contexts
            if ck not in cache and ck
        ]
        # Dedupe enqueue list — multiple sessions sharing a context_key
        # only need one queue row.
        seen: set[str] = set()
        unique_misses: list[tuple[str, dict[str, Any]]] = []
        for ck, ctx in misses:
            if ck in seen:
                continue
            seen.add(ck)
            unique_misses.append((ck, ctx))
        if unique_misses:
            self._enqueue(conn, unique_misses)

        rows: list[DerivedRow] = []
        for sess, context, context_key in sess_contexts:
            classification = cache.get(context_key)
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
                        "title": sess["title"],
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
            "cache_hits": len(unique_keys) - len(unique_misses),
            "cache_misses": len(unique_misses),
            "queued_for_classification": len(unique_misses),
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

    def _build_context(
        self,
        conn: "psycopg.Connection",
        sess: dict[str, Any],
    ) -> dict[str, Any]:
        """Assemble the classifier-context dict for one session.

        Always includes (device, app, title). For browser apps, looks
        up the most-recent `mac.zen.tab` event that started within
        _TAB_LOOKBACK_S of the session start to extract zen_container
        and url_host. NULL if no overlap (the session was a browser
        focus without a fresh tab event — rare; the LLM will see the
        title and fall back gracefully).

        Adjacent-chunk lookup (using prior chunks for context) is
        deferred to v2 — diminishing return relative to the deriver
        complexity it adds, and the tab/container signal is already
        the strongest disambiguator we have.
        """
        context: dict[str, Any] = {
            "device": sess.get("device"),
            "app": sess.get("app"),
            "title": sess.get("title"),
        }
        if sess.get("app") in _BROWSER_APPS:
            tab = self._fetch_recent_tab(conn, sess["start_ts"])
            if tab is not None:
                container = tab.get("container")
                url = tab.get("url")
                url_host: str | None = None
                if url:
                    try:
                        parsed = urlparse(url)
                        url_host = parsed.hostname or None
                    except (ValueError, TypeError):
                        # Malformed URL; skip per Tenet 2 — don't
                        # invent a fallback host, just let the field
                        # stay null.
                        url_host = None
                if container:
                    context["zen_container"] = container
                if url_host:
                    context["url_host"] = url_host
        return context

    def _fetch_recent_tab(
        self,
        conn: "psycopg.Connection",
        sess_start: datetime,
    ) -> dict[str, Any] | None:
        """Most recent `mac.zen.tab` event with
        start_ts <= sess_start AND start_ts >= sess_start - 5s.

        We pass the lookback as a `make_interval(secs => N)` rather
        than embedding it as a string literal — psycopg's `%s`
        substitution would render `INTERVAL '5 seconds'` correctly
        but ONLY if we pre-formatted the literal in Python, which
        smells like SQL injection even when the source is constant.
        `make_interval(secs => %s)` keeps the value in the parameter
        slot.
        """
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT data->>'container' AS container,
                       data->>'url'       AS url
                  FROM public.events
                 WHERE source = 'mac.zen.tab'
                   AND start_ts <= %s
                   AND start_ts >= %s - make_interval(secs => %s)
                 ORDER BY start_ts DESC
                 LIMIT 1
                """,
                (sess_start, sess_start, _TAB_LOOKBACK_S),
            )
            row = cur.fetchone()
            if row is None:
                return None
            return {"container": row[0], "url": row[1]}

    def _fetch_classifications_by_key(
        self,
        conn: "psycopg.Connection",
        context_keys: list[str],
    ) -> dict[str, dict[str, Any]]:
        if not context_keys:
            return {}
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT context_key, project_slug, category, model
                  FROM public.window_titles
                 WHERE context_key = ANY(%s)
                """,
                (context_keys,),
            )
            return {
                row[0]: {
                    "project_slug": row[1],
                    "category": row[2],
                    "model": row[3],
                }
                for row in cur.fetchall()
            }

    def _enqueue(
        self,
        conn: "psycopg.Connection",
        misses: list[tuple[str, dict[str, Any]]],
    ) -> None:
        """Insert pending classifications. ON CONFLICT DO NOTHING so
        re-deriving the same window doesn't reset the retry counter
        on rows that are already queued.

        We carry both `context_key` (the PK) and `context` (the
        JSONB the classifier_job will read), and ALSO populate
        `title` for human-readable debugging — the column is
        nullable post-0018, but a populated title is friendlier to
        anyone querying the queue manually.
        """
        if not misses:
            return
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO public.classification_queue (context_key, context, title)
                VALUES (%s, %s::jsonb, %s)
                ON CONFLICT (context_key) DO NOTHING
                """,
                [
                    (ck, json.dumps(ctx, sort_keys=True), ctx.get("title"))
                    for ck, ctx in misses
                ],
            )


def _context_key(context: dict[str, Any]) -> str:
    """SHA-256 of the canonicalized context dict.

    `sort_keys=True` ensures order-independence — adding fields in
    different orders across calls still produces the same hash. We
    JSON-encode rather than concatenating because JSON cleanly
    separates field boundaries (no risk of "ab" + "c" colliding
    with "a" + "bc").
    """
    payload = json.dumps(context, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _chunk_id(window_session_id: UUID) -> UUID:
    """Stable id keyed on the source window_session id. One chunk per
    session; replays produce the same id."""
    return uuid5(NAMESPACE_URL, f"project_chunk/v1:{window_session_id}")


register(ProjectChunkV1Deriver())
