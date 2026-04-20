-- Public schema: the ground-truth event stream, device registry,
-- categorization table, agent/user derived tables, and the LLM-
-- friendly enriched view.
--
-- RLS is enabled on everything; access is via the four application
-- roles (ingest_role / user_role / agent_role / service_role) with
-- grants declared in 50_grants.sql. No RLS policies yet — those
-- will land when/if a dashboard path needs them. Until then, role
-- grants are the sole gate.

-- ─────────────────────────────────────────────────────────────────
-- devices: the immutable identifiers that events carry.
-- Label and platform are metadata; device_id is what forwarders
-- stamp on outgoing events.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE public.devices (
  device_id   TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  platform    TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at  TIMESTAMPTZ,

  CONSTRAINT devices_label_nonempty CHECK (length(btrim(label)) > 0),
  CONSTRAINT devices_platform_valid
    CHECK (platform IN ('macos', 'android', 'ios', 'linux'))
);

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────
-- events: the append-only fact stream.
-- Writes come only through ingest_api.accept_event (which enforces
-- token auth, rate limits, and timestamp bounds). No role has direct
-- INSERT/UPDATE/DELETE on this table except service_role.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE public.events (
  id              UUID PRIMARY KEY,
  device          TEXT NOT NULL REFERENCES public.devices(device_id),
  source          TEXT NOT NULL,
  timestamp_utc   TIMESTAMPTZ NOT NULL,
  duration_s      DOUBLE PRECISION NOT NULL,
  data            JSONB NOT NULL,
  schema_version  SMALLINT NOT NULL DEFAULT 1,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_backfill     BOOLEAN NOT NULL DEFAULT FALSE,

  -- NaN, Infinity, -Infinity are all rejected: NaN >= 0 is FALSE,
  -- Infinity < Infinity is FALSE, -Infinity >= 0 is FALSE.
  CONSTRAINT events_duration_finite_nonneg
    CHECK (duration_s >= 0 AND duration_s < 'Infinity'::double precision),
  CONSTRAINT events_source_nonempty   CHECK (length(btrim(source)) > 0),
  CONSTRAINT events_schema_version_pos CHECK (schema_version > 0)
);

CREATE INDEX events_device_source_time ON public.events (device, source, timestamp_utc);
CREATE INDEX events_time_desc          ON public.events (timestamp_utc DESC);

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────
-- source_tags: cross-cutting categorization. (device, source, tag)
-- composite PK. Interpretation lives here so it can evolve without
-- rewriting events.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE public.source_tags (
  device     TEXT NOT NULL,
  source     TEXT NOT NULL,
  tag        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (device, source, tag),
  CONSTRAINT source_tags_device_nonempty CHECK (length(btrim(device)) > 0),
  CONSTRAINT source_tags_source_nonempty CHECK (length(btrim(source)) > 0),
  CONSTRAINT source_tags_tag_nonempty    CHECK (length(btrim(tag))    > 0)
);

ALTER TABLE public.source_tags ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────
-- Derived tables: reports, insights, annotations, prompts.
-- user_role has direct CRUD; agent_role writes only through
-- singleton agent_api.* functions.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE public.reports (
  id           UUID PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  origin       TEXT NOT NULL DEFAULT 'agent',
  window_start TIMESTAMPTZ,
  window_end   TIMESTAMPTZ,
  tags         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,

  CONSTRAINT reports_title_nonempty CHECK (length(btrim(title)) > 0),
  CONSTRAINT reports_origin_valid   CHECK (origin IN ('agent', 'user', 'system'))
);

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;


CREATE TABLE public.annotations (
  id         UUID PRIMARY KEY,
  scope      TEXT NOT NULL,                          -- 'event' | 'time_range' | 'source' | 'device' | 'day'
  scope_ref  TEXT NOT NULL,                          -- event id, ISO range, source name, device_id, or yyyy-mm-dd
  body       TEXT NOT NULL,
  origin     TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT annotations_scope_valid  CHECK (scope IN ('event','time_range','source','device','day')),
  CONSTRAINT annotations_body_nonempty CHECK (length(btrim(body)) > 0),
  CONSTRAINT annotations_origin_valid CHECK (origin IN ('agent', 'user', 'system'))
);

CREATE INDEX annotations_scope ON public.annotations (scope, scope_ref);

ALTER TABLE public.annotations ENABLE ROW LEVEL SECURITY;


-- prompts: agent-initiated questions. Answers flow back as events
-- (source = 'prompt.<kind>'), not as rows in this table. This table
-- only tracks question lifecycle.
CREATE TABLE public.prompts (
  id             UUID PRIMARY KEY,
  asked_by       TEXT NOT NULL,                      -- 'scheduled.daily' | 'agent.ad_hoc' | …
  kind           TEXT NOT NULL,                      -- 'sleep_latency' | 'mood' | …; becomes event.source suffix
  question       TEXT NOT NULL,
  context        JSONB NOT NULL DEFAULT '{}'::jsonb,
  answer_schema  JSONB,                              -- optional: {"type":"number","unit":"minutes"}
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at    TIMESTAMPTZ,
  dismissed_at   TIMESTAMPTZ,

  CONSTRAINT prompts_kind_nonempty     CHECK (length(btrim(kind)) > 0),
  CONSTRAINT prompts_question_nonempty CHECK (length(btrim(question)) > 0),
  -- A prompt can be answered OR dismissed, but not both. Null both = pending.
  CONSTRAINT prompts_answered_xor_dismissed
    CHECK (answered_at IS NULL OR dismissed_at IS NULL)
);

CREATE INDEX prompts_pending
  ON public.prompts (created_at DESC)
  WHERE answered_at IS NULL AND dismissed_at IS NULL;

ALTER TABLE public.prompts ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────
-- events_enriched: the LLM-friendly read surface.
-- Joins each event with its device's label/platform and rolls up
-- all source_tags into a single array column. Writes are not
-- supported (use ingest_api for that).
-- ─────────────────────────────────────────────────────────────────

-- security_invoker = true: the view runs with the caller's
-- privileges, not the owner's. This means RLS on events/devices
-- applies to the querying role (user_role, agent_role), rather
-- than silently bypassing it via the postgres-owned view.
-- Without this option Supabase's Security Advisor flags the view
-- as "publicly accessible" because a definer-view is the classic
-- way RLS gets circumvented.
CREATE VIEW public.events_enriched
  WITH (security_invoker = true)
AS
SELECT
  e.id,
  e.device,
  d.label    AS device_label,
  d.platform AS device_platform,
  e.source,
  e.timestamp_utc,
  e.duration_s,
  e.data,
  e.schema_version,
  e.received_at,
  e.is_backfill,
  COALESCE(
    (SELECT array_agg(t.tag ORDER BY t.tag)
     FROM   public.source_tags t
     WHERE  t.device = e.device AND t.source = e.source),
    ARRAY[]::TEXT[]
  ) AS tags
FROM public.events e
JOIN public.devices d ON d.device_id = e.device;

-- The diff tool doesn't always preserve view options across
-- CREATE-OR-REPLACE, so ALTER VIEW belt-and-suspenders sets it
-- every migration.
ALTER VIEW public.events_enriched SET (security_invoker = true);


-- ─────────────────────────────────────────────────────────────────
-- RLS policies. The real auth layer is Postgres role grants
-- (50_grants.sql); these policies shape each role's RLS-visible
-- surface to match intent.
--
-- Pattern:
--   events, devices        — read-only for user_role + agent_role.
--                            Writes go through ingest_api.accept_event
--                            (SECURITY DEFINER bypasses RLS).
--   source_tags            — user_role can curate directly; agent
--                            proposes via reports.
--   reports, annotations,
--   prompts                — user_role can CRUD directly; agent writes
--                            go through agent_api.* SECURITY DEFINER
--                            singletons.
--
-- Grants (in 50_grants.sql) still enforce the hard rules; policies
-- just narrow the RLS-visible surface so a grant drift doesn't widen
-- blast radius more than necessary.
-- ─────────────────────────────────────────────────────────────────

-- events: both roles read-only.
CREATE POLICY user_role_read_events   ON public.events FOR SELECT TO user_role  USING (true);
CREATE POLICY agent_role_read_events  ON public.events FOR SELECT TO agent_role USING (true);

-- devices: both roles read-only.
CREATE POLICY user_role_read_devices  ON public.devices FOR SELECT TO user_role  USING (true);
CREATE POLICY agent_role_read_devices ON public.devices FOR SELECT TO agent_role USING (true);

-- source_tags: user curates, agent reads.
CREATE POLICY user_role_all_source_tags   ON public.source_tags FOR ALL    TO user_role  USING (true) WITH CHECK (true);
CREATE POLICY agent_role_read_source_tags ON public.source_tags FOR SELECT TO agent_role USING (true);

-- reports / annotations / prompts: user CRUD, agent reads (writes via agent_api).
CREATE POLICY user_role_all_reports       ON public.reports     FOR ALL    TO user_role  USING (true) WITH CHECK (true);
CREATE POLICY agent_role_read_reports     ON public.reports     FOR SELECT TO agent_role USING (true);

CREATE POLICY user_role_all_annotations   ON public.annotations FOR ALL    TO user_role  USING (true) WITH CHECK (true);
CREATE POLICY agent_role_read_annotations ON public.annotations FOR SELECT TO agent_role USING (true);

CREATE POLICY user_role_all_prompts       ON public.prompts     FOR ALL    TO user_role  USING (true) WITH CHECK (true);
CREATE POLICY agent_role_read_prompts     ON public.prompts     FOR SELECT TO agent_role USING (true);
