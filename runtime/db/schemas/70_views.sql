-- Read-path views for the dashboard.
--
-- Each view's row shape mirrors the corresponding TypeScript type in
-- dashboard/src/features/today/types.ts so the fetcher in api.ts is
-- a thin pass-through. The dashboard reads via PostgREST as
-- `user_role` — grants below.
--
-- These views are deriver-output projections; they don't ship until
-- the deriver has produced rows. An empty derived_events table → an
-- empty view → an empty /today timeline.

-- =========================================================================
-- v_place_visit_today — place_visit/v1 rows pre-joined with `places`
--
-- Matches dashboard PlaceVisit type (kind, id, source, start_ts, end_ts,
-- data{place_id, lat, lng, brief_exit_count}, place{id, name, category}).
-- LEFT JOIN keeps visits with NULL place_id (bootstrap / OSM-down case).
-- =========================================================================

CREATE OR REPLACE VIEW public.v_place_visit_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,
  de.end_ts,
  jsonb_build_object(
    'place_id',         de.data->>'place_id',
    'lat',              (de.data->>'lat')::float8,
    'lng',              (de.data->>'lng')::float8,
    'brief_exit_count', COALESCE((de.data->>'brief_exit_count')::int, 0),
    -- `is_open` is computed at READ time (this view), not stored in
    -- data. A visit is open iff its end_ts is the global max for
    -- place_visit/v1 AND that end_ts is within 30 min of NOW().
    -- Self-corrects on agent crashes / stale data.
    'is_open',          (
      de.end_ts = (
        SELECT MAX(end_ts) FROM public.derived_events
         WHERE source = 'place_visit/v1'
      )
      AND (NOW() - de.end_ts) <= INTERVAL '30 minutes'
    )
  ) AS data,
  CASE
    WHEN p.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id',       p.id,
      'name',     p.name,
      -- Coalesce to 'mixed' so a hand-seeded place without a
      -- category still satisfies the dashboard's PlaceCategory
      -- (non-null) contract.
      'category', COALESCE(p.category, 'mixed'),
      -- The OSM POI's centroid — sits INSIDE the building extrusion,
      -- unlike the visit's stay-centroid which lands at the entrance.
      -- The dashboard uses this to query the right building for the
      -- 3D highlight.
      'centroid_lat', p.centroid_lat,
      'centroid_lng', p.centroid_lng
    )
  END AS place
FROM public.derived_events de
LEFT JOIN public.places p
  ON p.id = NULLIF(de.data->>'place_id', '')::uuid
WHERE de.source = 'place_visit/v1';


-- =========================================================================
-- v_travel_leg_today — travel_leg/v1 rows with `path` lifted out of `data`
--
-- The deriver inlines `path` into `data` for self-contained JSONB
-- storage; this view splits it back out so the row shape matches the
-- dashboard's TravelLeg type (path is a sibling of data).
-- =========================================================================

CREATE OR REPLACE VIEW public.v_travel_leg_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,
  de.end_ts,
  jsonb_build_object(
    'from_visit_id',     de.data->>'from_visit_id',
    'to_visit_id',       de.data->>'to_visit_id',
    'dominant_activity', de.data->>'dominant_activity',
    'distance_m',        (de.data->>'distance_m')::float8,
    'reading_count',     (de.data->>'reading_count')::int
  ) AS data,
  COALESCE(de.data->'path', '[]'::jsonb) AS path
FROM public.derived_events de
WHERE de.source = 'travel_leg/v1';


-- =========================================================================
-- v_user_active_today — user_active/v1 rows. Primitive activity-span
-- output consumed by the sleep deriver and (eventually) summary stats.
-- =========================================================================

CREATE OR REPLACE VIEW public.v_user_active_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,
  de.end_ts,
  jsonb_build_object(
    'device',      de.data->>'device',
    'event_count', COALESCE((de.data->>'event_count')::int, 0),
    'sources',     COALESCE(de.data->'sources', '[]'::jsonb)
  ) AS data
FROM public.derived_events de
WHERE de.source = 'user_active/v1';


-- =========================================================================
-- v_sleep_today — sleep/v1 rows. Dashboard uses kind='night' rows to
-- set the day's wake-time boundary instead of a static 04:00 cutoff.
-- kind='nap' rows render as Moments inside the timeline.
-- Each row's [start_ts, end_ts] IS the sleep span (start = onset,
-- end = wake).
-- =========================================================================

CREATE OR REPLACE VIEW public.v_sleep_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,
  de.end_ts,
  jsonb_build_object(
    'kind',             de.data->>'kind',                -- 'night' | 'nap'
    'confidence',       (de.data->>'confidence')::float8,
    'wake_local_date',  de.data->>'wake_local_date'
  ) AS data,
  jsonb_build_object(
    'disrupted_count',  COALESCE((de.provenance->>'disrupted_count')::int, 0),
    'duration_minutes', (de.provenance->>'duration_minutes')::float8,
    'wake_local_time',  de.provenance->>'wake_local_time',
    'rank',             COALESCE((de.provenance->>'rank')::int, 0)
  ) AS provenance
FROM public.derived_events de
WHERE de.source = 'sleep/v1';


-- =========================================================================
-- v_project_chunk_today — project_chunk/v1 rows pre-joined with `projects`
-- and a server-derived parent_id pointing at the place_visit/travel_leg
-- whose [start_ts, end_ts] CONTAINS the chunk's midpoint.
--
-- The dashboard nests topic chunks under their containing visit/leg
-- ("topic_chunk" kind, set client-side). Chunks that fall in a gap
-- (no GPS coverage / pre-onboarding) get parent_id = NULL and render
-- at the top level.
--
-- WHERE-clause is intentionally permissive (source filter only) so
-- pending / unclassified chunks still surface in a "classifying..."
-- state. The category COALESCE keeps the dashboard from crashing if
-- the LLM ever emits an unexpected value.
-- =========================================================================

CREATE OR REPLACE VIEW public.v_project_chunk_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,
  de.end_ts,
  jsonb_build_object(
    'project_slug', de.data->>'project_slug',
    'category',     COALESCE(
                      NULLIF(de.data->>'category', ''),
                      'neutral'
                    ),
    'device',       de.data->>'device',
    'app',          de.data->>'app',
    'title',        de.data->>'title',
    'classified',   COALESCE((de.data->>'classified')::boolean, false),
    'overridden',   COALESCE((de.data->>'overridden')::boolean, false)
  ) AS data,
  CASE
    WHEN p.slug IS NULL THEN NULL
    ELSE jsonb_build_object(
      'slug',        p.slug,
      'name',        p.name,
      'description', p.description,
      'archived',    (p.archived_at IS NOT NULL)
    )
  END AS project,
  parent.id AS parent_id,
  COALESCE(
    NULLIF(de.data->>'project_slug', ''),
    NULLIF(de.data->>'app', ''),
    'untitled'
  ) AS topic
FROM public.derived_events de
LEFT JOIN public.projects p
  ON p.slug = NULLIF(de.data->>'project_slug', '')
LEFT JOIN LATERAL (
  SELECT parent_de.id
    FROM public.derived_events parent_de
   WHERE parent_de.source IN ('place_visit/v1', 'travel_leg/v1')
     AND parent_de.start_ts <= de.start_ts + (de.end_ts - de.start_ts) / 2
     AND parent_de.end_ts   >= de.start_ts + (de.end_ts - de.start_ts) / 2
   ORDER BY parent_de.start_ts DESC
   LIMIT 1
) parent ON TRUE
WHERE de.source = 'project_chunk/v1';


-- Grants: user_role reads via PostgREST.
GRANT SELECT ON public.v_place_visit_today   TO user_role;
GRANT SELECT ON public.v_travel_leg_today    TO user_role;
GRANT SELECT ON public.v_sleep_today         TO user_role;
GRANT SELECT ON public.v_user_active_today   TO user_role;
GRANT SELECT ON public.v_project_chunk_today TO user_role;
