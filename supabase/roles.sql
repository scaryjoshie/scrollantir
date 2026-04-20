-- Custom Postgres roles for scrollantir. Applied via:
--     supabase db push --include-roles
--
-- Roles are created NOLOGIN here and with no password. The admin CLI
-- (scripts/admin.py) has a `setup-roles` command that assigns random
-- passwords via ALTER ROLE and emits the connection strings for the
-- edge function, Mac app, and Claude Code. Passwords live on the
-- user's admin Mac only; they never go into git.

-- ingest_role: connects from the Supabase Edge Function runtime.
-- Has EXECUTE on ingest_api.* only (see 50_grants.sql).
CREATE ROLE ingest_role NOLOGIN NOINHERIT;
ALTER ROLE ingest_role SET statement_timeout = '30s';

-- user_role: connects from the Swift Mac app when performing direct
-- UI actions. Has SELECT on all public + CRUD on derived tables.
CREATE ROLE user_role NOLOGIN NOINHERIT;
ALTER ROLE user_role SET statement_timeout = '30s';

-- agent_role: connects from Claude Code subprocesses. Has SELECT on
-- all public + EXECUTE on agent_api.* singletons only.
CREATE ROLE agent_role NOLOGIN NOINHERIT;
ALTER ROLE agent_role SET statement_timeout = '5s';
