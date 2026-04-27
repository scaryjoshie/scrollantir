-- Minimum role grants for v1.
-- Tightening (per-table CRUD splits, ingest/agent_api EXECUTE grants)
-- lands incrementally as the RPCs do.

-- agent_role: full read on public; nothing else. Writes go through
-- agent_api.* RPCs (added in commit #5).
GRANT USAGE ON SCHEMA public TO agent_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO agent_role;

-- user_role: read on public. Per-table CRUD on source_tags, places,
-- annotations gets added when the dashboard cuts over.
GRANT USAGE ON SCHEMA public TO user_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO user_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO user_role;

-- anon: nothing here yet. Specific EXECUTE grants on ingest_api.*
-- functions land in commit #3. Default is "anon can't see anything".

-- private.*: postgres superuser only. Roles never have direct access.
-- Token validation happens inside SECURITY DEFINER functions in
-- ingest_api.* that own the necessary privileges.
REVOKE ALL ON SCHEMA private FROM PUBLIC;
