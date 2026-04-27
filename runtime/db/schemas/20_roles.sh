#!/bin/bash
# Create the postgres roles with passwords from container env.
# Runs as part of /docker-entrypoint-initdb.d on first boot.
#
# Roles:
#   anon          NOLOGIN  — PostgREST falls back to this with no JWT
#   authenticator LOGIN    — PostgREST connects as this; SET ROLEs to others
#   ingest_role   NOLOGIN  — owns ingest_api functions; reached via SECURITY DEFINER
#   user_role     NOLOGIN  — dashboard reads via PostgREST switching into it (Path B later)
#   agent_role    LOGIN    — agent connects directly via psycopg from the runtime container

set -euo pipefail

: "${AUTHENTICATOR_PW:?AUTHENTICATOR_PW must be set in the postgres container env}"
: "${USER_PW:?USER_PW must be set in the postgres container env}"
: "${AGENT_PW:?AGENT_PW must be set in the postgres container env}"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname   "$POSTGRES_DB" <<-EOSQL
  -- PostgREST entry roles
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${AUTHENTICATOR_PW}';

  -- API roles (NOLOGIN where the role is only ever reached via SET ROLE)
  CREATE ROLE ingest_role NOLOGIN;
  CREATE ROLE user_role NOLOGIN;

  -- Direct-connect role (the agent container uses this)
  CREATE ROLE agent_role LOGIN PASSWORD '${AGENT_PW}';

  -- authenticator can switch into all of them
  GRANT anon, ingest_role, user_role, agent_role TO authenticator;

  -- user_role placeholder password — meaningful only if/when LOGIN is enabled later.
  -- Stored so admin can flip LOGIN without a rotation.
  ALTER ROLE user_role PASSWORD '${USER_PW}';
EOSQL
