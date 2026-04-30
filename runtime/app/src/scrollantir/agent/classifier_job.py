"""Classifier job — drains classification_queue via Cerebras/Groq.

Runs every CLASSIFIER_INTERVAL_S in the agent process. Pulls up to
BATCH_SIZE pending titles whose `next_attempt_at <= NOW()`, classifies
each via the LLM provider chain (one call per title — no batching),
and writes results to `window_titles`. On per-title failure, increments
`retries` and pushes `next_attempt_at` forward via exponential
backoff. After MAX_RETRIES the row stays in the queue with the last
error for inspection.

Why per-title, not batched: the user's window-change rate is low,
batching adds parser complexity, and a single bad title in a batch
shouldn't poison the whole batch. Cerebras + Groq are both fast
enough that 1 RPS is comfortable.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from scrollantir.core.classifier import (
    ClassificationResult,
    ClassifierError,
    classify,
)
from scrollantir.core.db import close_after, connect_agent

log = logging.getLogger("scrollantir.agent.classifier")


# How many pending titles to drain per tick. Cap so a backlog doesn't
# starve the deriver tick.
BATCH_SIZE = 20

# Backoff schedule (seconds) keyed on retry count. After the last
# entry, the row stays at `next_attempt_at` with the last error and
# isn't retried until manually requeued.
_BACKOFF_S: tuple[int, ...] = (60, 300, 1800, 7200)
MAX_RETRIES = len(_BACKOFF_S)


def run_classifier_tick() -> None:
    """One pass through the queue. Errors per title are logged and
    counted toward retries; the tick itself swallows wrapping
    exceptions so the scheduler keeps running."""
    try:
        with close_after(connect_agent()) as conn:
            projects = _fetch_active_projects(conn)
            if not projects:
                # No active projects → classifier can't choose anything
                # meaningful. Skip until projects exist.
                return
            queue = _claim_due_titles(conn, BATCH_SIZE)
            if not queue:
                return
            ok = 0
            failed = 0
            for title, retries in queue:
                try:
                    result = classify(title, projects)
                    _write_classification(conn, title, result)
                    ok += 1
                except ClassifierError as exc:
                    _record_failure(conn, title, retries, str(exc))
                    failed += 1
                except Exception as exc:  # noqa: BLE001
                    _record_failure(conn, title, retries, repr(exc))
                    failed += 1
            log.info(
                "classifier tick: ok=%d failed=%d projects=%d",
                ok, failed, len(projects),
            )
    except Exception:
        log.exception("classifier tick failed; will retry on next interval")


def _fetch_active_projects(conn) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT slug FROM public.projects
             WHERE archived_at IS NULL
             ORDER BY slug
            """
        )
        return [row[0] for row in cur.fetchall()]


def _claim_due_titles(conn, n: int) -> list[tuple[str, int]]:
    """Returns (title, retries) for up to N rows whose
    `next_attempt_at <= NOW()`. Doesn't lock — single classifier
    instance assumed (single agent process)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT title, retries FROM public.classification_queue
             WHERE next_attempt_at <= NOW()
             ORDER BY enqueued_at
             LIMIT %s
            """,
            (n,),
        )
        return [(row[0], row[1]) for row in cur.fetchall()]


def _write_classification(conn, title: str, result: ClassificationResult) -> None:
    """On success: upsert into window_titles, delete from queue."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO public.window_titles
                (title, project_slug, category, model)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (title) DO UPDATE SET
                project_slug = EXCLUDED.project_slug,
                category     = EXCLUDED.category,
                classified_at = NOW(),
                model        = EXCLUDED.model
              WHERE public.window_titles.overridden_at IS NULL
            """,
            (title, result.project_slug, result.category, result.model),
        )
        cur.execute(
            "DELETE FROM public.classification_queue WHERE title = %s",
            (title,),
        )
    conn.commit()


def _record_failure(conn, title: str, prev_retries: int, error: str) -> None:
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
             WHERE title = %s
            """,
            (new_retries, error[:1000], next_at, title),
        )
    conn.commit()
