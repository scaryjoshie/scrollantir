-- Grants for the four application roles. Roles themselves are
-- declared in ../roles.sql (applied via `supabase db push --include-roles`).
--
-- Principles:
--   anon       — nothing. Default-deny everywhere.
--   ingest_role — EXECUTE on ingest_api functions only. Cannot SELECT anything.
--   user_role  — SELECT on all public. Direct CRUD on derived tables + source_tags.
--                No access to events/devices writes. No private.*.
--   agent_role — SELECT on all public. Writes only via agent_api.* singletons.
--                No access to source_tags writes. No private.*.
--
-- service_role retains full cluster access by default (Supabase-managed);
-- no grants declared here for it.


-- ─────────────────────────────────────────────────────────────────
-- Revoke Supabase's permissive defaults on anon / authenticated.
-- New tables in public get auto-granted permissive privileges on
-- these roles; we strip them so RLS + explicit grants are the only
-- path to data.
-- ─────────────────────────────────────────────────────────────────

REVOKE ALL ON ALL TABLES    IN SCHEMA public  FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public  FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public  FROM anon, authenticated;

REVOKE ALL ON SCHEMA private FROM anon, authenticated, PUBLIC;


-- ─────────────────────────────────────────────────────────────────
-- ingest_role: edge function's role. EXECUTE on the three ingest_api
-- functions only. Cannot SELECT anything.
-- ─────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA ingest_api TO ingest_role;

GRANT EXECUTE ON FUNCTION ingest_api.accept_event(
    TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, DOUBLE PRECISION, JSONB, SMALLINT
  ) TO ingest_role;
GRANT EXECUTE ON FUNCTION ingest_api.accept_prompt_answer(TEXT, UUID, UUID, JSONB)
  TO ingest_role;
GRANT EXECUTE ON FUNCTION ingest_api.pending_prompts(TEXT) TO ingest_role;


-- ─────────────────────────────────────────────────────────────────
-- user_role: Swift dashboard UI, user-initiated actions.
-- SELECT on all public. Direct CRUD on derived + source_tags.
-- ─────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA public TO user_role;

GRANT SELECT ON public.events, public.devices, public.events_enriched
  TO user_role;
GRANT SELECT ON public.reports, public.insights, public.annotations,
                public.prompts, public.source_tags
  TO user_role;

GRANT INSERT, UPDATE, DELETE
  ON public.reports, public.insights, public.annotations,
     public.prompts, public.source_tags
  TO user_role;


-- ─────────────────────────────────────────────────────────────────
-- agent_role: Claude Code subprocess.
-- SELECT on all public. Writes only via agent_api.* singletons.
-- ─────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA public, agent_api TO agent_role;

GRANT SELECT ON public.events, public.devices, public.events_enriched
  TO agent_role;
GRANT SELECT ON public.reports, public.insights, public.annotations,
                public.prompts, public.source_tags
  TO agent_role;

GRANT EXECUTE ON FUNCTION agent_api.upsert_report(
    UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ
  ) TO agent_role;
GRANT EXECUTE ON FUNCTION agent_api.soft_delete_report(UUID) TO agent_role;

GRANT EXECUTE ON FUNCTION agent_api.upsert_insight(
    UUID, TEXT, TEXT, TEXT, TEXT, SMALLINT, TIMESTAMPTZ, TIMESTAMPTZ
  ) TO agent_role;
GRANT EXECUTE ON FUNCTION agent_api.soft_delete_insight(UUID) TO agent_role;

GRANT EXECUTE ON FUNCTION agent_api.upsert_annotation(UUID, TEXT, TEXT, TEXT)
  TO agent_role;
GRANT EXECUTE ON FUNCTION agent_api.soft_delete_annotation(UUID) TO agent_role;

GRANT EXECUTE ON FUNCTION agent_api.create_prompt(
    TEXT, TEXT, JSONB, JSONB, TIMESTAMPTZ, TEXT
  ) TO agent_role;


-- Explicit: neither user_role nor agent_role may touch private or
-- do anything to events/devices beyond SELECT.
REVOKE ALL ON SCHEMA private FROM user_role, agent_role;
REVOKE INSERT, UPDATE, DELETE ON public.events, public.devices
  FROM user_role, agent_role;
