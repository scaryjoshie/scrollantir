-- migrate:up
-- agent_role needs INSERT/UPDATE on public.places so the
-- place_visit/v1 deriver can upsert auto-discovered OSM features.
-- Original 90_grants.sql gave SELECT only.

GRANT INSERT, UPDATE ON public.places TO agent_role;

-- migrate:down
REVOKE INSERT, UPDATE ON public.places FROM agent_role;
