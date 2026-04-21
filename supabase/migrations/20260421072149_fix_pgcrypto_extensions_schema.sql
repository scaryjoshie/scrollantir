-- Fix: pgcrypto's digest() lives in the `extensions` schema on
-- Supabase, not public. The ingest_api.* functions pin their
-- search_path to (public, private, pg_temp), so unqualified digest()
-- calls failed with "function digest(text, unknown) does not exist"
-- on the first real invocation (functions compile without resolving
-- plpgsql body references).
--
-- Two pieces here:
--   1. Make the extension creation explicit about the schema so a
--      fresh environment reproduces the same layout.
--   2. CREATE OR REPLACE the three functions so their bodies use
--      extensions.digest(...) instead of the unqualified call.
--
-- Already applied idempotently on 2026-04-21 via psycopg; this
-- migration captures the change for reproducibility.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


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

  IF v_hits > 200 THEN
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


CREATE OR REPLACE FUNCTION ingest_api.accept_prompt_answer(
  p_token           TEXT,
  p_prompt_id       UUID,
  p_answer_event_id UUID,
  p_data            JSONB
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_hash      TEXT;
  v_device_id TEXT;
  v_kind      TEXT;
  v_source    TEXT;
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

  SELECT kind
    INTO v_kind
    FROM public.prompts
   WHERE id = p_prompt_id
     AND answered_at IS NULL
     AND dismissed_at IS NULL
     AND (expires_at IS NULL OR expires_at > NOW())
   FOR UPDATE;

  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'prompt not answerable (missing, already answered, dismissed, or expired)';
  END IF;

  v_source := 'prompt.' || v_kind;

  INSERT INTO public.events (
    id, device, source, timestamp_utc, duration_s, data, schema_version
  ) VALUES (
    p_answer_event_id, v_device_id, v_source, NOW(), 0, p_data, 1
  );

  UPDATE public.prompts   SET answered_at   = NOW() WHERE id = p_prompt_id;
  UPDATE private.tokens   SET last_used_at  = NOW() WHERE token_hash = v_hash;

  RETURN p_answer_event_id;
END
$$;


CREATE OR REPLACE FUNCTION ingest_api.pending_prompts(p_token TEXT)
RETURNS TABLE (
  id            UUID,
  kind          TEXT,
  question      TEXT,
  context       JSONB,
  answer_schema JSONB,
  created_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_hash      TEXT;
  v_device_id TEXT;
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

  UPDATE private.tokens SET last_used_at = NOW() WHERE token_hash = v_hash;

  RETURN QUERY
  SELECT p.id, p.kind, p.question, p.context, p.answer_schema,
         p.created_at, p.expires_at
    FROM public.prompts p
   WHERE p.answered_at IS NULL
     AND p.dismissed_at IS NULL
     AND (p.expires_at IS NULL OR p.expires_at > NOW())
   ORDER BY p.created_at DESC
   LIMIT 50;
END
$$;
