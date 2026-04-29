-- migrate:up
-- agent_role needs EXECUTE on public.* functions for the place_visit
-- deriver's GiST-indexed inserts (ll_to_earth → earth → ...) and
-- whatever future derivers reach for. PUBLIC stays revoked (defense
-- against anon hitting CPU-tunable extension functions); agent_role
-- gets blanket EXECUTE since it's a trusted internal role.

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO agent_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO agent_role;

-- migrate:down
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM agent_role;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM agent_role;
