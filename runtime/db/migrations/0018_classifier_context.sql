-- migrate:up
--
-- Phase D: classifier context enrichment.
--
-- The classifier currently sees just `title`. The biggest classification
-- gain available — per the 2026-04-30 audit (a042036) — is plumbing
-- context that's ALREADY captured in events:
--   - `device` (mac vs phone): different platforms imply different intent
--   - `app` (raw bundle / display name): cmux vs Slack vs Zen says a lot
--   - `zen_container` (Zen profile: Work / School / Personal): strongest
--     project signal we have
--   - `url_host` (browser tab host): localhost:5173 = scrollantir dev
--   - `adjacent_chunks` (recent 1-3 chunks): "this Slack DM after 30 min
--     of Cursor in scrollantir" → project=scrollantir
--
-- Cache key changes from `title` to a hash of the full context tuple.
-- Two titles with different contexts (e.g. "Notes" on a Work container
-- vs Personal) classify independently.
--
-- Existing window_titles + classification_queue rows are TRUNCATE'd
-- as part of the rollout. The Phase D context_key is computed from a
-- different tuple than Phase B's title-only key, so existing rows
-- can't be back-filled into a valid context_key (we'd hash just the
-- title and produce keys that don't match what the new deriver
-- emits). Per the user's explicit Phase D authorization, the
-- reclassification re-populates these tables under the new keying.

BEGIN;

-- 1. TRUNCATE both tables so the PK swap can land.
--
-- window_titles: cache loss is expected and self-healing — every
--   chunk's context will hit the queue on the next deriver tick.
-- classification_queue: ALSO truncated. This loses any pending retry
--   state from a prior Cerebras outage (per 30_tables.sql header,
--   the queue is meant to be durable). Acceptable here because the
--   deriver re-enqueues on next tick (project_chunk.py looks up by
--   context_key, misses, INSERT ON CONFLICT DO NOTHING). If a queue
--   had genuinely-stuck rows we'd lose their retries history; that's
--   a one-time exception for this schema swap.
TRUNCATE public.window_titles, public.classification_queue;

ALTER TABLE public.window_titles
  ADD COLUMN context_key TEXT,
  ADD COLUMN context     JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Drop old PK, add new on context_key.
ALTER TABLE public.window_titles
  DROP CONSTRAINT window_titles_pkey,
  ADD PRIMARY KEY (context_key);

-- Keep `title` for display + debugging. Make it nullable since rows now
-- key on context_key, not title.
ALTER TABLE public.window_titles
  ALTER COLUMN title DROP NOT NULL;

-- Index on title for human-readable lookups (debugging, dashboard
-- "what was I doing when X" queries).
CREATE INDEX window_titles_title ON public.window_titles (title);

-- 2. classification_queue: same shape change. `title` was the PK; swap
-- to context_key. Carry the full context JSONB so the classifier_job
-- has everything when it pulls a row to classify.
ALTER TABLE public.classification_queue
  ADD COLUMN context_key TEXT,
  ADD COLUMN context     JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.classification_queue
  DROP CONSTRAINT classification_queue_pkey,
  ADD PRIMARY KEY (context_key);

ALTER TABLE public.classification_queue
  ALTER COLUMN title DROP NOT NULL;

COMMIT;


-- migrate:down
-- Restoration is best-effort. Old PK was on `title` (TEXT NOT NULL).
-- After this migration runs, rows may have null title (deriver writes
-- only context_key). Down migration TRUNCATE's both tables, restores
-- old shape; live data is lost (recoverable via reclassification).

BEGIN;

TRUNCATE public.window_titles, public.classification_queue;

ALTER TABLE public.window_titles
  DROP CONSTRAINT window_titles_pkey,
  ALTER COLUMN title SET NOT NULL,
  ADD PRIMARY KEY (title),
  DROP COLUMN context_key,
  DROP COLUMN context;
DROP INDEX IF EXISTS window_titles_title;

ALTER TABLE public.classification_queue
  DROP CONSTRAINT classification_queue_pkey,
  ALTER COLUMN title SET NOT NULL,
  ADD PRIMARY KEY (title),
  DROP COLUMN context_key,
  DROP COLUMN context;

COMMIT;
