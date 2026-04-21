-- Raise ingest_api.accept_event's per-token-per-minute rate limit
-- from 200 → 10000.
--
-- Discovered during the first Mac-forwarder drain against Supabase:
-- ActivityWatch's multi-day backlog (2000+ window events per bucket)
-- blew the 200/min cap on first sync, and because accept_event
-- increments the counter on every call — including ON CONFLICT
-- no-op dupes from retries — the backlog could never drain.
--
-- 10000/min is still a meaningful runaway-client guard for a
-- single-user system (steady state is <30 events/min) but clears
-- real-world backfills cleanly.
--
-- The full updated function body is in
-- supabase/schemas/30_ingest_api.sql; this migration applies the
-- function definition change for reproducibility.

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

  INSERT INTO private.ingest_rate_limit (token_hash, window_start, hits)
  VALUES (v_hash, v_window, 1)
  ON CONFLICT (token_hash, window_start)
  DO UPDATE SET hits = private.ingest_rate_limit.hits + 1
  RETURNING hits INTO v_hits;

  IF v_hits > 10000 THEN
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
  ON CONFLICT (id) DO NOTHING;

  RETURN p_id;
END
$$;
