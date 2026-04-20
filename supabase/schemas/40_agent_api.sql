-- agent_api: singleton write paths for agent-generated derived data.
-- Every function touches exactly one row. The agent role has EXECUTE
-- on these functions and no direct INSERT/UPDATE/DELETE anywhere.
-- Mass mutation is structurally impossible from the agent.
--
-- Agents cannot modify rows they didn't originate. `origin = 'agent'`
-- is checked on every update/delete path; user-originated rows are
-- read-only from the agent's perspective.
--
-- All functions SECURITY DEFINER, search_path pinned to public.

CREATE SCHEMA IF NOT EXISTS agent_api;


-- ─────────────────────────────────────────────────────────────────
-- Reports
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION agent_api.upsert_report(
  p_id           UUID,
  p_title        TEXT,
  p_body         TEXT,
  p_tags         TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_window_start TIMESTAMPTZ DEFAULT NULL,
  p_window_end   TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.reports (id, title, body, origin, tags, window_start, window_end)
    VALUES (gen_random_uuid(), p_title, p_body, 'agent', p_tags, p_window_start, p_window_end)
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  UPDATE public.reports
     SET title        = p_title,
         body         = p_body,
         tags         = p_tags,
         window_start = p_window_start,
         window_end   = p_window_end,
         updated_at   = NOW()
   WHERE id = p_id
     AND origin = 'agent'
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'report % not mutable by agent (missing, wrong origin, or deleted)', p_id;
  END IF;
  RETURN p_id;
END
$$;


CREATE OR REPLACE FUNCTION agent_api.soft_delete_report(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.reports
     SET deleted_at = NOW(),
         updated_at = NOW()
   WHERE id = p_id
     AND origin = 'agent'
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'report % not deletable by agent', p_id;
  END IF;
END
$$;


-- ─────────────────────────────────────────────────────────────────
-- Annotations
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION agent_api.upsert_annotation(
  p_id        UUID,
  p_scope     TEXT,
  p_scope_ref TEXT,
  p_body      TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.annotations (id, scope, scope_ref, body, origin)
    VALUES (gen_random_uuid(), p_scope, p_scope_ref, p_body, 'agent')
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  UPDATE public.annotations
     SET scope      = p_scope,
         scope_ref  = p_scope_ref,
         body       = p_body,
         updated_at = NOW()
   WHERE id = p_id
     AND origin = 'agent'
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'annotation % not mutable by agent', p_id;
  END IF;
  RETURN p_id;
END
$$;


CREATE OR REPLACE FUNCTION agent_api.soft_delete_annotation(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.annotations
     SET deleted_at = NOW(),
         updated_at = NOW()
   WHERE id = p_id
     AND origin = 'agent'
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'annotation % not deletable by agent', p_id;
  END IF;
END
$$;


-- ─────────────────────────────────────────────────────────────────
-- Prompts (create only — agents ask, users answer)
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION agent_api.create_prompt(
  p_kind          TEXT,
  p_question      TEXT,
  p_context       JSONB DEFAULT '{}'::jsonb,
  p_answer_schema JSONB DEFAULT NULL,
  p_expires_at    TIMESTAMPTZ DEFAULT NULL,
  p_asked_by      TEXT DEFAULT 'agent.ad_hoc'
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.prompts (
    id, asked_by, kind, question, context, answer_schema, expires_at
  ) VALUES (
    v_id, p_asked_by, p_kind, p_question, p_context, p_answer_schema, p_expires_at
  );
  RETURN v_id;
END
$$;
