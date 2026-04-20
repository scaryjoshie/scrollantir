-- Custom Postgres roles for scrollantir. Applied via:
--     supabase db push --include-roles
--
-- Roles are created NOLOGIN here and with no password. The admin CLI
-- (scripts/admin.py) has a `setup-roles` command that assigns random
-- passwords via ALTER ROLE and emits the connection strings for the
-- edge function, Mac app, and Claude Code. Passwords live on the
-- user's admin Mac only; they never go into git.
--
-- Idempotent: CREATE ROLE wrapped in DO blocks because roles are
-- cluster-wide and survive `supabase db reset`. ALTER ROLE applies
-- idempotently on every push.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingest_role') THEN
    CREATE ROLE ingest_role NOLOGIN NOINHERIT;
  END IF;
END $$;
ALTER ROLE ingest_role SET statement_timeout = '30s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'user_role') THEN
    CREATE ROLE user_role NOLOGIN NOINHERIT;
  END IF;
END $$;
ALTER ROLE user_role SET statement_timeout = '30s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_role') THEN
    CREATE ROLE agent_role NOLOGIN NOINHERIT;
  END IF;
END $$;
ALTER ROLE agent_role SET statement_timeout = '5s';
