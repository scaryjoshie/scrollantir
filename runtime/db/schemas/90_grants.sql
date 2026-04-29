-- Minimum role grants for v1.
-- Tightening (per-table CRUD splits, ingest/agent_api EXECUTE grants)
-- lands incrementally as the RPCs do.

-- agent_role: full read on public; derived_events writes go through
-- agent_api.* RPCs (SECURITY DEFINER). public.places is the one
-- exception — the place_visit/v1 deriver upserts directly because
-- the upsert is not part of the derived-events replace-window flow
-- and wrapping it in an RPC would just be ceremony.
GRANT USAGE ON SCHEMA public TO agent_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO agent_role;
GRANT INSERT, UPDATE ON public.places TO agent_role;

-- agent_api.* — SECURITY DEFINER RPCs the agent calls for every write.
-- agent_role has EXECUTE; the function bodies own the necessary
-- privileges on public.derived_events etc. via the function owner.
GRANT USAGE ON SCHEMA agent_api TO agent_role;
GRANT EXECUTE ON FUNCTION
  agent_api.replace_derived_window(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB)
TO agent_role;

-- user_role: read on public. Per-table CRUD on source_tags, places,
-- annotations gets added when the dashboard cuts over.
GRANT USAGE ON SCHEMA public TO user_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO user_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO user_role;

-- anon: EXECUTE on the three ingest_api RPCs and nothing else.
-- These are SECURITY DEFINER functions that validate bearer tokens
-- internally; anon never sees private.tokens or writes events directly.
GRANT USAGE ON SCHEMA ingest_api TO anon;
GRANT EXECUTE ON FUNCTION
  ingest_api.accept_event(TEXT, UUID, TEXT, TIMESTAMPTZ, DOUBLE PRECISION, JSONB),
  ingest_api.accept_prompt_answer(TEXT, UUID, UUID, JSONB),
  ingest_api.pending_prompts(TEXT)
TO anon;

-- private.*: postgres superuser only. Roles never have direct access.
-- Token validation happens inside SECURITY DEFINER functions in
-- ingest_api.* that own the necessary privileges.
REVOKE ALL ON SCHEMA private FROM PUBLIC;

-- pgcrypto + earthdistance install functions into public schema with
-- default EXECUTE TO PUBLIC. Even with PostgREST's db-schemas excluding
-- `public`, PUBLIC-callable extension functions are a defense-in-depth
-- gap. SECURITY DEFINER functions (ingest_api.*) still reach digest()
-- etc. via search_path because they run as postgres (the function
-- owner), not as anon.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
