-- ingest_api: the only write path for incoming data from devices.
-- All functions are SECURITY DEFINER and run as the function owner
-- (the Supabase postgres role). The edge function connects as
-- ingest_role, which has EXECUTE on these functions and nothing else.
--
-- search_path is pinned to public, private, pg_temp on every function
-- to prevent search-path-based injection.

CREATE SCHEMA IF NOT EXISTS ingest_api;

-- Needed for digest() (sha256 hashing of bearer tokens). On Supabase
-- pgcrypto lives in the `extensions` schema, not `public`, so every
-- call site below uses `extensions.digest(...)` explicitly rather
-- than widening search_path to include extensions.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;


-- ─────────────────────────────────────────────────────────────────
-- accept_event: validate bearer, rate-limit, insert one event.
--
-- Returns the event's UUID on success. Raises on:
--   - invalid / revoked / expired-supersede token
--   - device mismatch (token.device_id != p_device)
--   - rate limit exceeded (>200 hits/token/minute)
--   - timestamp out of bounds (> now+5m OR < now-30d)
-- Dedupes via ON CONFLICT (id) DO NOTHING.
--
-- For source='phone.location', bucket lat/lng to 4 decimals (~11m)
-- before insert, so raw precision never hits storage.
-- ─────────────────────────────────────────────────────────────────

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
  -- Token validation. Superseded tokens are valid for up to 48h
  -- past superseded_at to support rotation overlap.
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

  -- Device-label spoofing guard.
  IF v_device_id <> p_device THEN
    RAISE EXCEPTION 'device mismatch: token bound to %, event claims %',
      v_device_id, p_device USING ERRCODE = '28000';
  END IF;

  -- Retired-device guard. A device can be retired via admin CLI
  -- without revoking its tokens (to preserve history); explicit
  -- reject here means retired-device events never land.
  IF EXISTS (
    SELECT 1 FROM public.devices
     WHERE device_id = p_device AND retired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'device % is retired', p_device USING ERRCODE = '28000';
  END IF;

  -- Fixed-window rate limit.
  INSERT INTO private.ingest_rate_limit (token_hash, window_start, hits)
  VALUES (v_hash, v_window, 1)
  ON CONFLICT (token_hash, window_start)
  DO UPDATE SET hits = private.ingest_rate_limit.hits + 1
  RETURNING hits INTO v_hits;

  -- Rate limit: 10000/min/token. Calibrated upward from an initial
  -- 200 because the first-sync backfill from ActivityWatch can push
  -- multiple thousands of events from a single bucket at once, and
  -- we want a clean drain rather than forcing N retries. Steady
  -- state is <30 events/min, so this mostly exists as a runaway-
  -- client guard, not a throughput throttle.
  IF v_hits > 10000 THEN
    RAISE EXCEPTION 'rate limit exceeded (% hits/min)', v_hits
      USING ERRCODE = '54000';  -- program_limit_exceeded
  END IF;

  -- Timestamp bounds.
  IF p_timestamp_utc > NOW() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'timestamp too far in future';
  END IF;
  IF p_timestamp_utc < NOW() - INTERVAL '30 days' THEN
    RAISE EXCEPTION 'timestamp too far in past (>30 days)';
  END IF;

  v_is_backfill := p_timestamp_utc < NOW() - INTERVAL '1 day';

  -- Location precision reduction at write time.
  v_data := p_data;
  IF p_source = 'phone.location' AND v_data ? 'lat' AND v_data ? 'lng' THEN
    v_data := jsonb_set(v_data, '{lat}',
      to_jsonb(round((v_data->>'lat')::numeric, 4)));
    v_data := jsonb_set(v_data, '{lng}',
      to_jsonb(round((v_data->>'lng')::numeric, 4)));
  END IF;

  -- Update last_used_at opportunistically.
  UPDATE private.tokens SET last_used_at = NOW() WHERE token_hash = v_hash;

  -- Insert. Idempotent on retry via deterministic UUIDs.
  INSERT INTO public.events (
    id, device, source, timestamp_utc, duration_s, data, schema_version, is_backfill
  ) VALUES (
    p_id, p_device, p_source, p_timestamp_utc, p_duration_s, v_data, p_schema_version, v_is_backfill
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN p_id;
END
$$;


-- ─────────────────────────────────────────────────────────────────
-- accept_prompt_answer: atomic UPDATE prompts.answered_at + INSERT
-- the answer as an event with source='prompt.<kind>'.
--
-- This is its own function (not part of accept_event) because the
-- semantics differ: it mutates two tables in a single transaction,
-- derives the event's source from the prompt's kind column, and
-- the timestamp is always NOW() (answers are real-time).
-- ─────────────────────────────────────────────────────────────────

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
  -- Token validation (same policy as accept_event).
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

  -- Look up and lock the prompt, confirming it's still answerable.
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

  -- Order matters: INSERT the answer event FIRST, without ON CONFLICT,
  -- so a UUID collision raises and rolls back the whole transaction.
  -- If we did the prompt UPDATE first and INSERT second, a silent
  -- ON CONFLICT DO NOTHING would leave the prompt marked answered
  -- with no answer event on record.
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


-- ─────────────────────────────────────────────────────────────────
-- pending_prompts: read-side for phone-polling. Returns any
-- unanswered, undismissed, unexpired prompts — gated by the caller's
-- bearer. The phone polls this every 30s or on screen-on, instead
-- of subscribing via Supabase Realtime (which would require a JWT).
-- ─────────────────────────────────────────────────────────────────

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
