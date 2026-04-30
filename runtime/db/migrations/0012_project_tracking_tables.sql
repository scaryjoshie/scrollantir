-- migrate:up
-- Three tables to support per-window project + productivity
-- classification:
--
--   public.projects            — user-curated active projects
--   public.window_titles       — classification cache (title → project,
--                                category) populated by the LLM job
--   public.classification_queue — pending titles awaiting classification
--
-- The dashboard reads projects + window_titles for /projects + per-
-- visit/per-session breakdowns. The agent classifier job pulls from
-- classification_queue, calls Cerebras (Groq fallback), and writes
-- to window_titles. project_chunk/v1 deriver enqueues new titles
-- and reads back classifications on subsequent ticks.

CREATE TABLE public.projects (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (slug ~ '^[a-z][a-z0-9_-]*$')
);

CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


CREATE TABLE public.window_titles (
  title           TEXT PRIMARY KEY,
  project_slug    TEXT REFERENCES public.projects(slug),
  category        TEXT NOT NULL CHECK (category IN ('work', 'play', 'neutral')),
  classified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model           TEXT NOT NULL,
  overridden_at   TIMESTAMPTZ
);

CREATE INDEX window_titles_project ON public.window_titles (project_slug)
  WHERE project_slug IS NOT NULL;


CREATE TABLE public.classification_queue (
  title             TEXT PRIMARY KEY,
  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retries           INT NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (retries >= 0)
);

CREATE INDEX classification_queue_due ON public.classification_queue (next_attempt_at);

-- Grants: agent_role writes (classifier job + derivers); user_role
-- reads (dashboard /projects page + per-visit detail).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects             TO agent_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.window_titles        TO agent_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.classification_queue TO agent_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects             TO user_role;
GRANT SELECT                          ON public.window_titles       TO user_role;
GRANT SELECT                          ON public.classification_queue TO user_role;

-- migrate:down
DROP TABLE IF EXISTS public.classification_queue;
DROP TABLE IF EXISTS public.window_titles;
DROP TABLE IF EXISTS public.projects;
