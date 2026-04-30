-- migrate:up
--
-- Drop the 'personal' project entirely. The data model becomes:
--
--   project_slug != null  IFF  category = 'work'
--
-- enforced via a CHECK constraint on `window_titles`. After this:
--   - Work-categorized chunks: project_slug = real project (cado, scrollantir, …)
--   - Play / Neutral chunks: project_slug = NULL
--   - 'misc' / 'personal' / wildcard concept exists ONLY as the legend's
--     "+N more" tail collapse for visual readability (dashboard concern).
--
-- ROLLOUT REQUIREMENT: agent must be STOPPED before applying. The running
-- classifier_job otherwise tries to write project_slug='personal' for
-- new sessions during the brief window between this migration and the
-- classifier code update — would FK-violate after the project row is
-- gone. After this migration:
--   1. Apply 0015_view_harden.sql
--   2. Deploy new classifier.py + window_session.py code
--   3. Restart agent (it will re-derive cleanly)
--   4. Deploy new dashboard (TopicChunk.project nullable)
--
-- Pre-2026-04-29 events were already wiped by the user's clean-slate
-- decision; this migration only deals with post-29 data still using
-- the 'personal' slug.

BEGIN;

-- 1. NULL out FK refs in the classification cache. Re-classification
--    is unnecessary: any title whose only signal was "personal" was
--    a non-work title, so NULL is the correct new value. Keep category.
UPDATE public.window_titles
   SET project_slug = NULL
 WHERE project_slug = 'personal';

-- 2. Rewrite project_chunk events that embedded 'personal' in JSONB.
--    Same logic: 'personal' → NULL.
UPDATE public.derived_events
   SET data = jsonb_set(data, '{project_slug}', 'null'::jsonb, true)
 WHERE source = 'project_chunk/v1'
   AND data->>'project_slug' = 'personal';

-- 3. Now safe to delete the project row — no rows reference it.
DELETE FROM public.projects WHERE slug = 'personal';

-- 4. Enforce the tree-model invariant at the DB layer.
--    The classifier's validator + view's coercion are belt-and-
--    suspenders; this CHECK is the truth.
ALTER TABLE public.window_titles
  ADD CONSTRAINT window_titles_project_implies_work
  CHECK (project_slug IS NULL OR category = 'work');

COMMIT;


-- migrate:down
ALTER TABLE public.window_titles
  DROP CONSTRAINT IF EXISTS window_titles_project_implies_work;

-- Best-effort restore of the 'personal' project so the tree-model
-- assumptions in older code don't immediately break. We can't restore
-- the project_slug repointings on derived_events (one-way loss).
INSERT INTO public.projects (slug, name, description)
  VALUES ('personal', 'Personal', 'wildcard catch-all (deprecated)')
  ON CONFLICT (slug) DO NOTHING;
