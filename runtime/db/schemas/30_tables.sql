-- Canonical schema for scrollantir. Source: docs/data-model.md (and
-- docs/concepts/places.md for places). Two-table event model
-- (raw + derived) with their distinct mutation contracts; agent-
-- authored reports/annotations/prompts; bearer-token credential storage
-- in private.

-- =========================================================================
-- Generic helper: BEFORE UPDATE trigger that maintains updated_at.
-- Attached below to places, reports, annotations.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =========================================================================
-- public.devices
-- Physical hosts (phone, mac) and synthetic services (cloud).
-- Referenced as the FK target for events.device (the generated first
-- segment of source).
-- =========================================================================

CREATE TABLE public.devices (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('physical', 'service')),
  label       TEXT,
  platform    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =========================================================================
-- public.events  (raw, immutable, collector-written)
-- One row per local observation. id is deterministic per (collector,
-- bucket, row) so retries are no-ops via ON CONFLICT.
--
-- Time model: (start_ts, end_ts) is canonical; duration_s is generated.
-- Wire format keeps (start_ts, duration_s) for collector simplicity;
-- ingest_api computes end_ts at insert time.
--
-- device is derived from source's first segment, so collectors can't
-- emit a mismatched (device, source) pair.
--
-- Date-bound CHECKs catch clock-skewed collectors. Bounds are hard-coded
-- because Postgres forbids NOW() in CHECK constraints (volatile).
-- =========================================================================

CREATE TABLE public.events (
  id           UUID PRIMARY KEY,
  source       TEXT NOT NULL
                 CHECK (source ~ '^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$'),
  device       TEXT GENERATED ALWAYS AS (split_part(source, '.', 1)) STORED
                 REFERENCES public.devices(id) ON DELETE RESTRICT,
  start_ts     TIMESTAMPTZ NOT NULL,
  end_ts       TIMESTAMPTZ NOT NULL,
  duration_s   DOUBLE PRECISION GENERATED ALWAYS AS
                 (EXTRACT(EPOCH FROM (end_ts - start_ts))) STORED,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_ts >= start_ts),
  CHECK (start_ts >= '2020-01-01'::timestamptz),
  CHECK (start_ts <  '2050-01-01'::timestamptz)
);

-- Composite (source, start_ts) supports both source-only filters
-- (leading column) and source+window filters. device is determined by
-- source's leading segment, so a separate (device, source, ...) index
-- would be redundant.
CREATE INDEX events_source_start ON public.events (source, start_ts);
CREATE INDEX events_start_desc   ON public.events (start_ts DESC);


-- =========================================================================
-- public.derived_events  (computed, append-only)
-- Products of derivers. source is '<kind>/<version>' (e.g. 'place_visit/v1').
-- Replace-window primitive (DELETE WHERE source=? AND start_ts in [w0,w1))
-- keys on (source, start_ts).
--
-- provenance JSONB is mandatory and structured: {inputs, source_event_ids,
-- confirmation}. CHECK enforces the object shape and required keys.
-- =========================================================================

CREATE TABLE public.derived_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source      TEXT NOT NULL
                CHECK (source ~ '^[a-z][a-z0-9_]*/v[1-9][0-9]*$'),
  start_ts    TIMESTAMPTZ NOT NULL,
  end_ts      TIMESTAMPTZ NOT NULL,
  duration_s  DOUBLE PRECISION GENERATED ALWAYS AS
                (EXTRACT(EPOCH FROM (end_ts - start_ts))) STORED,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance  JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_ts >= start_ts),
  CHECK (start_ts >= '2020-01-01'::timestamptz),
  CHECK (start_ts <  '2050-01-01'::timestamptz),
  CHECK (
    jsonb_typeof(provenance) = 'object'
    AND provenance ? 'inputs'
    AND provenance ? 'source_event_ids'
  )
);

CREATE INDEX derived_events_source_start ON public.derived_events (source, start_ts);
CREATE INDEX derived_events_start_desc   ON public.derived_events (start_ts DESC);
-- Partial index for project_chunk/v1 lookups: the v_project_chunk_today
-- view filters by source AND uses a LATERAL containment join against
-- place_visit/v1 + travel_leg/v1 spans. (start_ts, end_ts) restricted
-- to project_chunk/v1 covers both the WHERE filter and the lateral
-- midpoint lookup.
CREATE INDEX derived_events_project_chunk_span
  ON public.derived_events (start_ts, end_ts)
  WHERE source = 'project_chunk/v1';


-- =========================================================================
-- public.source_tags
-- Cross-cutting categorization keyed on the full dotted source.
-- ('phone.youtube.shorts', 'short_form'), etc. User-curated.
-- =========================================================================

CREATE TABLE public.source_tags (
  source  TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (source, tag)
);


-- =========================================================================
-- public.prompts
-- Agent-authored questions for the user. Answered prompts hold a pointer
-- to the answer event; LLM derivers' complete() runs poll-fired against
-- (answered_at IS NOT NULL AND derived_at IS NULL).
--
-- ctx JSONB is the between-stages state store for LLM derivers — what
-- forward() needs preserved at complete() time.
--
-- Lifecycle CHECKs enforce: expires_at after created_at, can't be
-- "answered" without an answer event, can't be "derived" without being
-- answered first.
-- =========================================================================

CREATE TABLE public.prompts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL,
  question         TEXT NOT NULL,
  ctx              JSONB NOT NULL DEFAULT '{}'::jsonb,
  answer_schema    JSONB,
  expires_at       TIMESTAMPTZ NOT NULL,
  asked_by         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at      TIMESTAMPTZ,
  answer_event_id  UUID REFERENCES public.events(id),
  derived_at       TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK ((answered_at IS NULL) = (answer_event_id IS NULL)),
  CHECK ((derived_at IS NULL) OR (answered_at IS NOT NULL))
);

-- Runner's "answered, not yet derived" poll uses this.
CREATE INDEX prompts_pending_derive
  ON public.prompts (answered_at)
  WHERE derived_at IS NULL;

-- "Have I asked this kind today?"
CREATE INDEX prompts_kind_created ON public.prompts (kind, created_at DESC);


-- =========================================================================
-- public.reports
-- Agent-authored daily/weekly/pattern reports. Markdown body for v1.
--
-- Future: a `frames JSONB DEFAULT '[]'` column may join body once the
-- dashboard ships a frame renderer (charts, tables, etc.). Migration is
-- purely additive — old markdown bodies keep rendering as-is.
-- =========================================================================

CREATE TABLE public.reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  window_start  TIMESTAMPTZ,
  window_end    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX reports_tags_gin     ON public.reports USING gin (tags);
CREATE INDEX reports_created_desc ON public.reports (created_at DESC);

CREATE TRIGGER reports_set_updated_at
  BEFORE UPDATE ON public.reports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =========================================================================
-- public.annotations
-- Agent- and user-authored notes attached to a scope. Soft-delete only.
-- =========================================================================

CREATE TABLE public.annotations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       TEXT NOT NULL CHECK (scope IN ('event', 'range', 'day', 'source', 'device')),
  scope_ref   TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX annotations_scope ON public.annotations (scope, scope_ref);

CREATE TRIGGER annotations_set_updated_at
  BEFORE UPDATE ON public.annotations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =========================================================================
-- public.places
-- Named-location layer. Joined query-time against phone.location.reading
-- by the place_visit/v1 deriver (radius via earth_distance).
-- Single-user; if multi-user ever, user_id is a new column.
--
-- See concepts/places.md "Index-using radius queries" — the GiST index
-- below only serves earth_box(...) @> ll_to_earth(...) bounding-box
-- prefilters, not earth_distance(...) < radius directly. Derivers must
-- use the two-stage prefilter+exact pattern.
--
-- OSM-backed identity (added 2026-04-29 for place_visit/v1):
-- `(osm_feature_type, osm_feature_id)` is the natural key for places
-- auto-discovered via Mapbox Tilequery. Manual entries leave both NULL
-- (UNIQUE allows multiple NULL pairs). `centroid_lat/lng` are the
-- canonical coords; legacy `lat/lng` shadow them until v1 drops the
-- shadow columns. `first_seen_ts` / `last_seen_ts` are deriver-
-- maintained activity timestamps.
-- =========================================================================

CREATE TABLE public.places (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  category        TEXT,
  lat             DOUBLE PRECISION NOT NULL,
  lng             DOUBLE PRECISION NOT NULL,
  radius_m        REAL NOT NULL DEFAULT 50,
  schedule        JSONB,
  metadata        JSONB,
  -- OSM identity (nullable for hand-added places; UNIQUE on the pair).
  osm_feature_type TEXT,
  osm_feature_id   BIGINT,
  centroid_lat    DOUBLE PRECISION,
  centroid_lng    DOUBLE PRECISION,
  first_seen_ts   TIMESTAMPTZ,
  last_seen_ts    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (lat BETWEEN -90 AND 90),
  CHECK (lng BETWEEN -180 AND 180),
  CHECK (radius_m > 0),
  CHECK (centroid_lat IS NULL OR centroid_lat BETWEEN -90 AND 90),
  CHECK (centroid_lng IS NULL OR centroid_lng BETWEEN -180 AND 180),
  -- Both NULL or both NOT NULL — partial OSM identity is an error.
  CHECK ((osm_feature_type IS NULL) = (osm_feature_id IS NULL)),
  UNIQUE (osm_feature_type, osm_feature_id)
);

CREATE INDEX places_category ON public.places (category);
CREATE INDEX places_geo      ON public.places USING gist (ll_to_earth(lat, lng));

CREATE TRIGGER places_set_updated_at
  BEFORE UPDATE ON public.places
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =========================================================================
-- public.projects
-- User-curated list of active projects. Slug is the stable key the
-- LLM classifier returns and the dashboard renders. Archive (don't
-- delete) when a project ends so historical project_chunk rows still
-- resolve. User can edit name/description; slug is immutable once
-- assigned (rename = create new + archive old).
-- =========================================================================

CREATE TABLE public.projects (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (slug ~ '^[a-z][a-z0-9_-]*$')
);

CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =========================================================================
-- public.window_titles
-- Classification cache, keyed on the EXACT window title string.
-- The first time a title is seen, project_chunk/v1 enqueues it for
-- LLM classification; subsequent hits read straight from this table.
-- A user override sets `overridden_at` and pins the row regardless
-- of future re-classification attempts. project_slug is nullable —
-- a title may not belong to any project (random browsing, etc.).
-- =========================================================================

CREATE TABLE public.window_titles (
  title           TEXT PRIMARY KEY,
  project_slug    TEXT REFERENCES public.projects(slug),
  -- TopicCategory: 'work' | 'play' | 'neutral'. The "is this
  -- productive?" axis, orthogonal to project membership. A YouTube
  -- tab classifies as 'work' (Karpathy lecture) or 'play' (TikTok)
  -- with the same project_slug nullable.
  category        TEXT NOT NULL CHECK (category IN ('work', 'play', 'neutral')),
  classified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 'cerebras:llama3.1-8b' / 'groq:llama3-8b-8192' / 'manual' (user
  -- override). Lets us re-classify rows that were tagged by an older
  -- model without scrubbing the cache.
  model           TEXT NOT NULL,
  -- User override timestamp; set when the user manually corrects a
  -- classification via the dashboard. Pinned rows are never
  -- re-classified by the agent.
  overridden_at   TIMESTAMPTZ
);

CREATE INDEX window_titles_project ON public.window_titles (project_slug)
  WHERE project_slug IS NOT NULL;


-- =========================================================================
-- public.classification_queue
-- Pending titles waiting for LLM classification. The classifier job
-- pulls rows here every minute, calls Cerebras (with Groq fallback),
-- writes to window_titles on success, and either deletes or
-- increments retries on failure. Durable so a Cerebras outage
-- doesn't lose progress.
-- =========================================================================

CREATE TABLE public.classification_queue (
  title         TEXT PRIMARY KEY,
  enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retries       INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  -- Cooldown after a failure — `retries` doubles the wait. The job
  -- skips rows whose `next_attempt_at > NOW()`.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (retries >= 0)
);

CREATE INDEX classification_queue_due ON public.classification_queue (next_attempt_at);


-- =========================================================================
-- private.tokens
-- Bearer-token credential store. Stores sha256(plaintext); plaintext
-- never lives server-side. Revocable via revoked_at.
-- token_hash length CHECK pins it to a SHA-256 digest (32 bytes).
-- =========================================================================

CREATE TABLE private.tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     TEXT NOT NULL REFERENCES public.devices(id) ON DELETE RESTRICT,
  token_hash    BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  prefix        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX tokens_device_active
  ON private.tokens (device_id)
  WHERE revoked_at IS NULL;


-- =========================================================================
-- private.ingest_rate_limit
-- Per-device fixed-window counter. accept_event resets the window every
-- 60s and rejects when count_in_window exceeds the configured limit.
-- =========================================================================

CREATE TABLE private.ingest_rate_limit (
  device_id        TEXT PRIMARY KEY REFERENCES public.devices(id) ON DELETE CASCADE,
  window_start     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count_in_window  INTEGER NOT NULL DEFAULT 0
);
