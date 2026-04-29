-- agent_api — write path for the agent process. agent_role calls
-- these via PostgREST RPC; functions are SECURITY DEFINER so
-- agent_role itself doesn't need direct INSERT/DELETE/UPDATE on
-- public.derived_events.
--
-- search_path is pinned to public, private, pg_temp on every function
-- to prevent search-path-based privilege escalation, mirroring the
-- ingest_api convention.
--
-- Parameter convention is `p_*` because plpgsql params would otherwise
-- collide with column names. PostgREST exposes the raw param names in
-- its JSON API: callers POST {"p_source": "...", "p_start": "...", ...}.

-- =========================================================================
-- replace_derived_window — atomic delete+insert for one (source,
-- window). The canonical write primitive for derivers. Idempotent:
-- re-running with identical p_rows produces an identical end-state.
--
-- Window semantics: half-open `[p_start, p_end)`. DELETE keys on
-- start_ts within the window — rows whose start_ts falls outside are
-- untouched even if their span overlaps the boundary. This matches
-- data-model.md §4.idempotency and the existing
-- `derived_events_source_start` btree index.
--
-- p_rows is a JSONB array of objects, each with:
--   id (optional UUID; defaults to gen_random_uuid),
--   source TEXT (must equal p_source — guards against caller bugs),
--   start_ts TIMESTAMPTZ (must lie in [p_start, p_end)),
--   end_ts TIMESTAMPTZ,
--   data JSONB (defaults to '{}'),
--   provenance JSONB (required; CHECK at table level enforces shape)
--
-- Returns the number of rows inserted.
-- =========================================================================

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
  -- Window sanity. Cheaper than letting per-row CHECKs catch this.
  IF p_end <= p_start THEN
    RAISE EXCEPTION 'window end must be > start (% >= %)', p_start, p_end
      USING ERRCODE = '22023';
  END IF;

  -- p_source must match the kind/version regex; the table CHECK does
  -- the same on insert, but failing fast here gives a cleaner error.
  IF p_source !~ '^[a-z][a-z0-9_]*/v[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'invalid p_source: %', p_source USING ERRCODE = '22023';
  END IF;

  -- jsonb_typeof(NULL) returns NULL, so a bare `<> 'array'` check
  -- would short-circuit on a NULL caller and silently clear the
  -- window via the DELETE below. Reject NULL explicitly.
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a JSONB array (got %)',
      COALESCE(jsonb_typeof(p_rows), 'null')
      USING ERRCODE = '22023';
  END IF;

  -- Cross-row validation. A caller passing rows with mixed sources or
  -- with timestamps outside the declared window is a bug — reject up
  -- front rather than letting half the rows land.
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

  -- Atomic replace. Single transaction (PostgREST wraps each call).
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
