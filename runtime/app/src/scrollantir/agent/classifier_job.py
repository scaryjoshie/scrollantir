"""Classifier job — drains classification_queue via Cerebras/Groq.

Runs every CLASSIFIER_INTERVAL_S in the agent process. Pulls up to
BATCH_SIZE pending rows whose `next_attempt_at <= NOW()`, classifies
each via the LLM provider chain (one call per row — no batching),
and writes results to `window_titles`. On per-row failure, increments
`retries` and pushes `next_attempt_at` forward via exponential
backoff. After MAX_RETRIES the row stays in the queue with the last
error for inspection.

Phase D (2026-04-30) keying change: rows are keyed on `context_key`
(SHA-256 of the full classifier-context dict), not on `title`. The
deriver writes (context_key, context, title) into the queue; this
job reads context out of the JSONB column and passes it to the
classifier so the LLM sees the same context the cache hashed on.

Why per-row, not batched: the user's window-change rate is low,
batching adds parser complexity, and a single bad title in a batch
shouldn't poison the whole batch. Cerebras + Groq are both fast
enough that 1 RPS is comfortable.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from scrollantir.core.classifier import (
    ClassificationResult,
    ClassifierError,
    classify,
)
from scrollantir.core.db import close_after, connect_agent

log = logging.getLogger("scrollantir.agent.classifier")


# How many pending rows to drain per tick. Cap so a backlog doesn't
# starve the deriver tick AND so we stay under provider rate limits.
# Cerebras + Groq free tiers throttle around ~30 RPM combined. With
# inter-call sleep of INTER_CALL_SLEEP_S, batch * 60/tick / sleep
# stays well under that.
BATCH_SIZE = 10
INTER_CALL_SLEEP_S = 0.7  # ~14 calls/min/provider — safely below RPM caps

# Backoff schedule (seconds) keyed on retry count. After the last
# entry, the row stays at `next_attempt_at` with the last error and
# isn't retried until manually requeued.
_BACKOFF_S: tuple[int, ...] = (60, 300, 1800, 7200)
MAX_RETRIES = len(_BACKOFF_S)


def run_classifier_tick() -> None:
    """One pass through the queue. Errors per row are logged and
    counted toward retries; the tick itself swallows wrapping
    exceptions so the scheduler keeps running."""
    try:
        with close_after(connect_agent()) as conn:
            projects = _fetch_active_projects(conn)
            if not projects:
                # No active projects → classifier can't choose anything
                # meaningful. Skip until projects exist.
                return
            queue = _claim_due(conn, BATCH_SIZE)
            if not queue:
                return
            ok = 0
            failed = 0
            for i, (context_key, context, retries) in enumerate(queue):
                if i > 0:
                    time.sleep(INTER_CALL_SLEEP_S)
                # Title is for logging + the classifier prompt's
                # headline. Pull it out of the context dict (always
                # populated by the deriver), with a defensive
                # fallback so a hand-inserted queue row without
                # context.title still classifies.
                title = (context or {}).get("title", "") or ""
                try:
                    result = classify(title, projects, context=context)
                    _write_classification(conn, context_key, context, title, result)
                    ok += 1
                except ClassifierError as exc:
                    _record_failure(conn, context_key, retries, str(exc))
                    failed += 1
                except Exception as exc:  # noqa: BLE001
                    _record_failure(conn, context_key, retries, repr(exc))
                    failed += 1
            log.info(
                "classifier tick: ok=%d failed=%d projects=%d",
                ok, failed, len(projects),
            )
    except Exception:
        log.exception("classifier tick failed; will retry on next interval")


def _fetch_active_projects(conn) -> list[tuple[str, str | None]]:
    """Return (slug, description) for active projects. Description
    feeds the LLM prompt so the model can disambiguate between
    similarly-named slugs (e.g. 'cado' vs 'color3') based on what
    each project actually is."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT slug, description FROM public.projects
             WHERE archived_at IS NULL
             ORDER BY slug
            """
        )
        return [(row[0], row[1]) for row in cur.fetchall()]


def _claim_due(conn, n: int) -> list[tuple[str, dict[str, Any], int]]:
    """Returns (context_key, context, retries) for up to N rows whose
    `next_attempt_at <= NOW()`. Doesn't lock — single classifier
    instance assumed (single agent process).

    `context` arrives as a Python dict thanks to psycopg's JSONB
    adapter; we coerce defensively in case a hand-inserted row
    stored it as something else.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT context_key, context, retries FROM public.classification_queue
             WHERE next_attempt_at <= NOW()
             ORDER BY enqueued_at
             LIMIT %s
            """,
            (n,),
        )
        out: list[tuple[str, dict[str, Any], int]] = []
        for row in cur.fetchall():
            ctx = row[1] if isinstance(row[1], dict) else {}
            out.append((row[0], ctx, row[2]))
        return out


def _write_classification(
    conn,
    context_key: str,
    context: dict[str, Any],
    title: str,
    result: ClassificationResult,
) -> None:
    """On success: upsert into window_titles, delete from queue.

    Title is stored alongside the row for debugging — it's the
    human-readable bit when you run `SELECT title, project_slug
    FROM window_titles WHERE …`. Non-PK; the row is unique on
    context_key.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.window_titles
                (context_key, context, title, project_slug, category, model)
            VALUES (%s, %s::jsonb, %s, %s, %s, %s)
            ON CONFLICT (context_key) DO UPDATE SET
                context      = EXCLUDED.context,
                title        = EXCLUDED.title,
                project_slug = EXCLUDED.project_slug,
                category     = EXCLUDED.category,
                classified_at = NOW(),
                model        = EXCLUDED.model
              WHERE public.window_titles.overridden_at IS NULL
            """,
            (
                context_key,
                json.dumps(context, sort_keys=True),
                title or None,
                result.project_slug,
                result.category,
                result.model,
            ),
        )
        cur.execute(
            "DELETE FROM public.classification_queue WHERE context_key = %s",
            (context_key,),
        )
    conn.commit()


def _record_failure(conn, context_key: str, prev_retries: int, error: str) -> None:
    """On failure: increment retries, push next_attempt_at via backoff.
    After MAX_RETRIES the row stays parked with the last error."""
    new_retries = prev_retries + 1
    if new_retries < MAX_RETRIES:
        backoff = _BACKOFF_S[new_retries]
        next_at = datetime.now(timezone.utc) + timedelta(seconds=backoff)
    else:
        # Park indefinitely; manual re-queue (UPDATE next_attempt_at)
        # required to retry.
        next_at = datetime.now(timezone.utc) + timedelta(days=365)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.classification_queue
               SET retries         = %s,
                   last_error      = %s,
                   next_attempt_at = %s
             WHERE context_key = %s
            """,
            (new_retries, error[:1000], next_at, context_key),
        )
    conn.commit()
