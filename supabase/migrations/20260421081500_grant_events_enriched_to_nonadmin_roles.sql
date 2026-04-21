-- Re-grant SELECT on public.events_enriched to agent_role and user_role.
--
-- 50_grants.sql already declares this grant, but the live DB had
-- lost it — likely because the view was re-created (`CREATE OR
-- REPLACE VIEW`) after initial apply, and Postgres drops all
-- non-owner privileges on CREATE OR REPLACE for views. The grant
-- must be re-asserted any time the view definition is rewritten.
--
-- Discovered when the orchestrator agent (Phase 0 local run) hit
-- `permission denied for view events_enriched` on its first SELECT.
-- Dropped agent_role off the canonical read surface and forced a
-- fallback to the base tables — fine for a workaround but makes the
-- LLM-friendly enriched view unreachable.
--
-- GRANT is idempotent, safe to re-run.

GRANT SELECT ON public.events_enriched TO agent_role, user_role;
