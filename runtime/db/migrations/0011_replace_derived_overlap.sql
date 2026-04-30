-- migrate:up
-- Adds a second write primitive for derivers whose rows are SPANS
-- that may extend beyond the deriver's tick window.
--
-- The original `replace_derived_window` deletes rows by
-- `start_ts ∈ [p_start, p_end)`. That works for tick-local
-- derivations but fails for long-running spans: an overnight stay
-- whose start_ts is yesterday gets stranded as a stale row when
-- today's tick re-derives, because today's window doesn't contain
-- yesterday's start_ts. Result: duplicate same-place rows, stale
-- end_ts, broken idempotency.
--
-- `replace_derived_overlap` deletes rows whose SPAN overlaps the
-- window (start_ts < p_end AND end_ts > p_start), and accepts new
-- rows whose start_ts may fall before p_start as long as their
-- span overlaps. This lets a span-emitting deriver re-derive the
-- "true" full extent of an overnight stay every tick — old rows
-- get cleared by overlap, new rows reflect current evidence.
--
-- Used by: place_visit/v1, travel_leg/v1, user_active/v1, sleep/v1.
-- replace_derived_window stays around for any future tick-local
-- deriver (LLM heuristics, point-in-time computations).

CREATE OR REPLACE FUNCTION agent_api.replace_derived_overlap(
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

  -- Each row's span must OVERLAP [p_start, p_end). Span = [start_ts,
  -- end_ts]. Overlap iff start_ts < p_end AND end_ts > p_start. The
  -- row's own start_ts MAY fall before p_start (this is the whole
  -- point of overlap mode); only end_ts is bounded.
  SELECT COUNT(*) INTO v_out_of_band
    FROM jsonb_array_elements(p_rows) AS row
   WHERE (row->>'start_ts')::timestamptz >= p_end
      OR (row->>'end_ts')::timestamptz   <= p_start;
  IF v_out_of_band > 0 THEN
    RAISE EXCEPTION '% row(s) have a span that does not overlap [%, %)',
      v_out_of_band, p_start, p_end USING ERRCODE = '22023';
  END IF;

  -- Atomic replace by span overlap. Single transaction.
  DELETE FROM public.derived_events
   WHERE source = p_source
     AND start_ts <  p_end
     AND end_ts   >  p_start;

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

GRANT EXECUTE ON FUNCTION agent_api.replace_derived_overlap(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB) TO agent_role;

-- migrate:down
DROP FUNCTION IF EXISTS agent_api.replace_derived_overlap(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, JSONB);
