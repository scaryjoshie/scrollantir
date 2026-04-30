-- migrate:up
--
-- SOFT TREE MODEL (revised 2026-04-30, supersedes earlier strict-IFF draft)
--
-- `project_slug` and `category` are independent axes:
--   - `(scrollantir, neutral)`  — admin work adjacent to a project (.env edits)
--   - `(learning-guitar, work)` — focused effort on a personal project
--   - `(null, work)`            — focused work outside any tracked project
--   - `(null, play|neutral)`    — non-project life
--
-- This migration:
--   1. Repoints existing 'personal' refs to NULL (the project is being removed)
--   2. Deletes the 'personal' project row
--   3. Adds `projects.default_category` — soft hint, NOT enforced; chunk-level
--      category is always the truth.
--   4. Does NOT add a CHECK constraint coupling project_slug and category.
--      Live data has 110 rows that would have failed the strict-IFF check;
--      the user explicitly pushed back on the strictness. See TENETS Tenet 3
--      for the soft-model rationale.
--
-- ROLLOUT: agent must be STOPPED before applying. Classifier deploy + cache
-- truncate sequence (see TODO.md Phase B playbook).

BEGIN;

-- 1. NULL out FK refs in the classification cache. The `personal` project was
--    a wildcard catch-all — its semantic content was "no specific project,"
--    which is exactly what NULL means under the new model. Category is kept
--    as-is; pre-existing `(personal, work)` becomes `(NULL, work)` honestly.
UPDATE public.window_titles
   SET project_slug = NULL
 WHERE project_slug = 'personal';

-- 2. Rewrite project_chunk events that embedded 'personal' in JSONB.
UPDATE public.derived_events
   SET data = jsonb_set(data, '{project_slug}', 'null'::jsonb, true)
 WHERE source = 'project_chunk/v1'
   AND data->>'project_slug' = 'personal';

-- 3. Delete the project row.
DELETE FROM public.projects WHERE slug = 'personal';

-- 4. Add default_category as a soft hint. NULL allowed (no presumption);
--    constrained to the same vocabulary as window_titles.category for
--    consistency. Dashboard may use this for default sort/grouping; the
--    chunk-level category always wins.
ALTER TABLE public.projects
  ADD COLUMN default_category TEXT
  CHECK (default_category IS NULL OR default_category IN ('work', 'play', 'neutral'));

-- Backfill existing projects with sensible defaults. All current named
-- projects (cado, scrollantir, school, color3, dagsmith) are work-flavored.
UPDATE public.projects SET default_category = 'work' WHERE default_category IS NULL;

COMMIT;


-- migrate:down
ALTER TABLE public.projects DROP COLUMN IF EXISTS default_category;

INSERT INTO public.projects (slug, name, description)
  VALUES ('personal', 'Personal', 'wildcard catch-all (deprecated)')
  ON CONFLICT (slug) DO NOTHING;
-- Note: cannot restore the JSONB project_slug repointings on derived_events
-- (one-way data loss). Window_titles refs likewise stay NULL.
