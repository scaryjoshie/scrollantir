-- migrate:up
-- agent_api.replace_derived_window — atomic delete+insert for one
-- (source, window). Canonical write primitive for derivers.
-- See runtime/db/schemas/60_agent_api.sql for the canonical body;
-- this migration is the forward-applied copy for live DBs.

-- Idempotent on fresh DBs (10_schemas.sql already creates this) but
-- required for live DBs that booted before commit 1b.
CREATE SCHEMA IF NOT EXISTS agent_api;

CREATE OR REPLACE FUNCTION agent_api.replace_derived_window(
  p_source TEXT,
  p_start  TIMESTAMPTZ,
  p_end    TIMESTAMPTZ,
  p_rows   JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_inserted    INTEGER := 0;
  v_bad_source  INTEGER;
  v_out_of_band INTEGER;
BEGIN
  IF p_end <= p_start THEN
    RAISE EXCEPTION 'window end must be > start (% >= %)', p_start, p_end
      USING ERRCODE = '22023';
  END IF;

  IF p_source !~ '^[a-z][a-z0-9_]*/v[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'invalid p_source: %', p_source USING ERRCODE = '22023';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSONB array (got %)',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*) INTO v_bad_source
    FROM jsonb_array_elements(p_rows) AS row
   WHERE row->>'source' IS DISTINCT FROM p_source;
  IF v_bad_source > 0 THEN
    RAISE EXCEPTION '% row(s) have a source != p_source (%)',
      v_bad_source, p_source USING ERRCODE = '22023';
  END IF;

  SELECT COUNT(*) INTO v_out_of_band
    FROM jsonb_array_elements(p_rows) AS row
   WHERE (row->>'start_ts')::timestamptz <  p_start
      OR (row->>'start_ts')::timestamptz >= p_end;
  IF v_out_of_band > 0 THEN
    RAISE EXCEPTION '% row(s) have start_ts outside [%, %)',
      v_out_of_band, p_start, p_end USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.derived_events
   WHERE source = p_source
     AND start_ts >= p_start
     AND start_ts <  p_end;

  INSERT INTO public.derived_events (id, source, start_ts, end_ts, data, provenance)
  SELECT
    COALESCE((row->>'id')::uuid, gen_random_uuid()),
    row->>'source',
    (row->>'start_ts')::timestamptz,
    (row->>'end_ts')::timestamptz,
    COALESCE(row->'data', '{}'::jsonb),
    row->'provenance'
  FROM jsonb_array_elements(p_rows) AS row;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END
$$;

GRANT USAGE ON SCHEMA agent_api TO agent_role;
GRANT EXECUTE ON FUNCTION
  agent_api.replace_derived_window(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB)
TO agent_role;

-- migrate:down
REVOKE EXECUTE ON FUNCTION
  agent_api.replace_derived_window(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB)
FROM agent_role;
DROP FUNCTION IF EXISTS agent_api.replace_derived_window(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB);
