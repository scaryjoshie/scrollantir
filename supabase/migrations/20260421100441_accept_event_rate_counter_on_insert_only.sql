-- accept_event rate-counter fix: only increment the per-minute rate
-- counter when the INSERT actually adds a new row.
--
-- Background: the previous version incremented on every call —
-- which meant ON-CONFLICT DO NOTHING no-ops from a forwarder's
-- retry loop burnt budget against themselves. A bucket with
-- >10000 events of backlog would trip the 10000/min cap on first
-- send, leave the forwarder checkpoint unadvanced, retry same
-- batch next minute, burn the full 10000 budget on no-ops, trip
-- the cap again, never progress. Livelock.
--
-- Fix (per FU-1): peek the counter before doing the insert (raise
-- early if already at cap), then do `INSERT ... ON CONFLICT DO
-- NOTHING RETURNING id`, and only increment the counter when
-- RETURNING shows a row was actually inserted. Retries of already-
-- ingested events cost DB work but don't count toward the cap.
--
-- Applied live via CREATE OR REPLACE on 2026-04-21; this migration
-- captures the change for reproducibility against a clean re-push.

CREATE OR REPLACE FUNCTION ingest_api.accept_event(
  p_token          TEXT,
  p_id             UUID,
  p_device         TEXT,
  p_source         TEXT,
  p_timestamp_utc  TIMESTAMPTZ,
  p_duration_s     DOUBLE PRECISION,
  p_data           JSONB,
  p_schema_version SMALLINT DEFAULT 1
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_hash         TEXT;
  v_device_id    TEXT;
  v_window       TIMESTAMPTZ := date_trunc('minute', NOW());
  v_hits         INTEGER;
  v_is_backfill  BOOLEAN;
  v_data         JSONB;
  v_inserted_id  UUID;
BEGIN
  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');
  SELECT device_id
    INTO v_device_id
    FROM private.tokens
   WHERE token_hash = v_hash
     AND revoked_at IS NULL
     AND (superseded_at IS NULL
          OR superseded_at > NOW() - INTERVAL '48 hours');
  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'invalid or revoked token' USING ERRCODE = '28000';
  END IF;

  IF v_device_id <> p_device THEN
    RAISE EXCEPTION 'device mismatch: token bound to %, event claims %',
      v_device_id, p_device USING ERRCODE = '28000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.devices
     WHERE device_id = p_device AND retired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'device % is retired', p_device USING ERRCODE = '28000';
  END IF;

  -- Rate-limit peek: read current minute's counter, raise if already
  -- at cap, do NOT increment here. Increment happens only on actual
  -- insert below.
  SELECT hits INTO v_hits
    FROM private.ingest_rate_limit
   WHERE token_hash = v_hash AND window_start = v_window;
  IF v_hits IS NULL THEN v_hits := 0; END IF;
  IF v_hits >= 10000 THEN
    RAISE EXCEPTION 'rate limit exceeded (% hits/min)', v_hits
      USING ERRCODE = '54000';
  END IF;

  IF p_timestamp_utc > NOW() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'timestamp too far in future';
  END IF;
  IF p_timestamp_utc < NOW() - INTERVAL '30 days' THEN
    RAISE EXCEPTION 'timestamp too far in past (>30 days)';
  END IF;

  v_is_backfill := p_timestamp_utc < NOW() - INTERVAL '1 day';

  v_data := p_data;
  IF p_source = 'phone.location' AND v_data ? 'lat' AND v_data ? 'lng' THEN
    v_data := jsonb_set(v_data, '{lat}',
      to_jsonb(round((v_data->>'lat')::numeric, 4)));
    v_data := jsonb_set(v_data, '{lng}',
      to_jsonb(round((v_data->>'lng')::numeric, 4)));
  END IF;

  UPDATE private.tokens SET last_used_at = NOW() WHERE token_hash = v_hash;

  INSERT INTO public.events (
    id, device, source, timestamp_utc, duration_s, data, schema_version, is_backfill
  ) VALUES (
    p_id, p_device, p_source, p_timestamp_utc, p_duration_s, v_data, p_schema_version, v_is_backfill
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    INSERT INTO private.ingest_rate_limit (token_hash, window_start, hits)
    VALUES (v_hash, v_window, 1)
    ON CONFLICT (token_hash, window_start)
    DO UPDATE SET hits = private.ingest_rate_limit.hits + 1;
  END IF;

  RETURN p_id;
END
$$;
