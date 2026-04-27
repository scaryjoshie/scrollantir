-- Schema namespaces.
--   public      — data + agent-authored content (default; already exists)
--   private     — credential storage (tokens, rate limits); never exposed via PostgREST
--   ingest_api  — RPCs collectors call (anon → SECURITY DEFINER → ingest_role)
--   agent_api   — RPCs the agent calls (agent_role → SECURITY DEFINER)

CREATE SCHEMA IF NOT EXISTS private;
CREATE SCHEMA IF NOT EXISTS ingest_api;
CREATE SCHEMA IF NOT EXISTS agent_api;
