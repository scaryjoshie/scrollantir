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
    -- `is_open` flags the latest visit when the user is still likely
    -- there (end_ts ≤ open_visit_max_age_min behind the deriver run's
    -- window end). COALESCE keeps pre-migration rows defaulting to
    -- closed instead of NULL.
    'is_open',          COALESCE((de.data->>'is_open')::boolean, false)
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


-- Grants: user_role reads via PostgREST.
GRANT SELECT ON public.v_place_visit_today TO user_role;
GRANT SELECT ON public.v_travel_leg_today  TO user_role;
