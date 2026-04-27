-- Postgres extensions used across the schema.
--   pgcrypto      — gen_random_uuid(), digest()
--   cube          — prerequisite for earthdistance
--   earthdistance — ll_to_earth(), earth_distance(); used by places radius queries

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
