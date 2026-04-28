-- ingest_api — write path for incoming data from devices.
--
-- All functions are SECURITY DEFINER and run as the function owner
-- (postgres superuser, set during init). The `anon` role has EXECUTE
-- but no direct grants on private.* or public.events; the SECURITY
-- DEFINER context is what lets the function read tokens and write
-- events on behalf of the caller.
--
-- search_path is pinned to public, private, pg_temp on every function
-- to prevent search-path-based privilege escalation.
--
-- Parameter convention is `p_*` because plpgsql params would otherwise
-- collide with column names of the same kind. PostgREST exposes the
-- raw param names in its JSON API: callers POST {"p_token": "...",
-- "p_id": "...", ...}.

-- =========================================================================
-- accept_event — validate bearer, rate-limit, insert one raw event.
--
-- Returns the event UUID on success. Raises on:
--   - invalid / revoked token
--   - source's first segment doesn't match the token's device_id
--   - negative duration
--   - rate limit exceeded (10000 hits/min per device)
-- Idempotent via ON CONFLICT (id) DO NOTHING — retries are no-ops.
-- =========================================================================

CREATE OR REPLACE FUNCTION ingest_api.accept_event(
  p_token       TEXT,
  p_id          UUID,
  p_source      TEXT,
  p_start_ts    TIMESTAMPTZ,
  p_duration_s  DOUBLE PRECISION,
  p_data        JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_hash         BYTEA;
  v_device_id    TEXT;
  v_source_dev   TEXT;
  v_window       TIMESTAMPTZ := date_trunc('minute', NOW());
  v_hits         INTEGER;
  v_inserted_id  UUID;
BEGIN
  -- Token validation. Hash plaintext, look up active token.
  v_hash := digest(p_token, 'sha256');
  SELECT device_id INTO v_device_id
    FROM private.tokens
   WHERE token_hash = v_hash AND revoked_at IS NULL;
  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'invalid or revoked token' USING ERRCODE = '28000';
  END IF;

  -- Source-prefix vs token-device. The events FK on the generated
  -- device column would catch this too, but the explicit check gives
  -- a clearer error and short-circuits before touching the rate limit.
  v_source_dev := split_part(p_source, '.', 1);
  IF v_source_dev <> v_device_id THEN
    RAISE EXCEPTION 'source device mismatch: token=%, source-prefix=%',
      v_device_id, v_source_dev USING ERRCODE = '28000';
  END IF;

  -- Wire-format sanity.
  IF p_duration_s < 0 THEN
    RAISE EXCEPTION 'duration_s cannot be negative'
      USING ERRCODE = '22023';  -- invalid_parameter_value
  END IF;

  -- Rate-limit peek. Read current minute's count without incrementing.
  -- The increment happens only on a real INSERT (not ON CONFLICT no-op),
  -- so duplicate retries don't burn budget against themselves.
  SELECT count_in_window INTO v_hits
    FROM private.ingest_rate_limit
   WHERE device_id = v_device_id AND window_start = v_window;
  v_hits := COALESCE(v_hits, 0);
  IF v_hits >= 10000 THEN
    RAISE EXCEPTION 'rate limit exceeded (% hits/min)', v_hits
      USING ERRCODE = '54000';
  END IF;

  -- Insert. Idempotent by id. RETURNING populates v_inserted_id only
  -- when a new row landed; ON CONFLICT no-ops leave it NULL.
  INSERT INTO public.events (id, source, start_ts, end_ts, data)
  VALUES (
    p_id,
    p_source,
    p_start_ts,
    p_start_ts + make_interval(secs => p_duration_s),
    p_data
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING id INTO v_inserted_id;

  -- Charge budget only on real inserts. Single-row upsert with window
  -- reset baked into the ON CONFLICT branch — if the existing window
  -- matches the current minute, increment; else reset to 1.
  IF v_inserted_id IS NOT NULL THEN
    INSERT INTO private.ingest_rate_limit (device_id, window_start, count_in_window)
    VALUES (v_device_id, v_window, 1)
    ON CONFLICT (device_id) DO UPDATE SET
      window_start    = EXCLUDED.window_start,
      count_in_window = CASE
        WHEN private.ingest_rate_limit.window_start = EXCLUDED.window_start
          THEN private.ingest_rate_limit.count_in_window + 1
        ELSE 1
      END;
  END IF;

  -- Token activity stamp.
  UPDATE private.tokens SET last_used_at = NOW() WHERE token_hash = v_hash;

  RETURN p_id;
END
$$;


-- =========================================================================
-- accept_prompt_answer — atomic UPDATE prompts + INSERT the answer
-- event with source='prompt.<kind>'.
--
-- Order matters: INSERT the answer event FIRST so a UUID collision
-- (caller provided a duplicate p_answer_event_id) raises and rolls
-- back the whole transaction. Doing UPDATE first would leave the
-- prompt marked answered with no answer event on record.
-- =========================================================================

CREATE OR REPLACE FUNCTION ingest_api.accept_prompt_answer(
  p_token            TEXT,
  p_prompt_id        UUID,
  p_answer_event_id  UUID,
  p_data             JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_hash    BYTEA;
  v_kind    TEXT;
  v_source  TEXT;
BEGIN
  v_hash := digest(p_token, 'sha256');
  IF NOT EXISTS (
    SELECT 1 FROM private.tokens
     WHERE token_hash = v_hash AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid or revoked token' USING ERRCODE = '28000';
  END IF;

  -- Lock + look up the prompt; confirm still answerable.
  SELECT kind INTO v_kind
    FROM public.prompts
   WHERE id = p_prompt_id
     AND answered_at IS NULL
     AND expires_at  > NOW()
   FOR UPDATE;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'prompt % not answerable (missing, already answered, or expired)',
      p_prompt_id;
  END IF;

  v_source := 'prompt.' || v_kind;

  -- Answer is a point event (duration 0). Insert first; on ID
  -- collision the rollback leaves the prompt unaffected.
  INSERT INTO public.events (id, source, start_ts, end_ts, data)
  VALUES (p_answer_event_id, v_source, NOW(), NOW(), p_data);

  -- Mark answered + link. Lifecycle CHECK on prompts requires both
  -- columns to be set together, so we can't split this into two updates.
  UPDATE public.prompts
     SET answered_at     = NOW(),
         answer_event_id = p_answer_event_id
   WHERE id = p_prompt_id;

  UPDATE private.tokens SET last_used_at = NOW() WHERE token_hash = v_hash;

  RETURN p_answer_event_id;
END
$$;


-- =========================================================================
-- pending_prompts — read-side for client polling.
--
-- Returns unanswered, unexpired prompts. Phone polls every ~30s or on
-- screen-on. No JWT, no Realtime channel — just a SELECT gated by the
-- caller's bearer.
-- =========================================================================

CREATE OR REPLACE FUNCTION ingest_api.pending_prompts(p_token TEXT)
RETURNS TABLE (
  id             UUID,
  kind           TEXT,
  question       TEXT,
  ctx            JSONB,
  answer_schema  JSONB,
  created_at     TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_hash BYTEA;
BEGIN
  v_hash := digest(p_token, 'sha256');
  IF NOT EXISTS (
    SELECT 1 FROM private.tokens
     WHERE token_hash = v_hash AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid or revoked token' USING ERRCODE = '28000';
  END IF;

  UPDATE private.tokens SET last_used_at = NOW() WHERE token_hash = v_hash;

  RETURN QUERY
  SELECT p.id, p.kind, p.question, p.ctx, p.answer_schema,
         p.created_at, p.expires_at
    FROM public.prompts p
   WHERE p.answered_at IS NULL
     AND p.expires_at  > NOW()
   ORDER BY p.created_at DESC
   LIMIT 50;
END
$$;
