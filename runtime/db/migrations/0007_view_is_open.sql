-- migrate:up
-- Re-create v_place_visit_today exposing `is_open` from data jsonb.
-- The deriver tags the latest visit as `is_open=true` when its end_ts
-- is within `open_visit_max_age_min` (default 30) of the deriver
-- window end. The dashboard renders open visits as a live "currently
-- here" indicator instead of a closed time range.
--
-- Pre-migration rows have no `is_open` key — COALESCE keeps them
-- defaulting to false until the deriver next replaces the rolling
-- window (≤5 min after this migration applies).

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
    'is_open',          COALESCE((de.data->>'is_open')::boolean, false)
  ) AS data,
  CASE
    WHEN p.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id',           p.id,
      'name',         p.name,
      'category',     COALESCE(p.category, 'mixed'),
      'centroid_lat', p.centroid_lat,
      'centroid_lng', p.centroid_lng
    )
  END AS place
FROM public.derived_events de
LEFT JOIN public.places p
  ON p.id = NULLIF(de.data->>'place_id', '')::uuid
WHERE de.source = 'place_visit/v1';

-- migrate:down
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
    'brief_exit_count', COALESCE((de.data->>'brief_exit_count')::int, 0)
  ) AS data,
  CASE
    WHEN p.id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id',           p.id,
      'name',         p.name,
      'category',     COALESCE(p.category, 'mixed'),
      'centroid_lat', p.centroid_lat,
      'centroid_lng', p.centroid_lng
    )
  END AS place
FROM public.derived_events de
LEFT JOIN public.places p
  ON p.id = NULLIF(de.data->>'place_id', '')::uuid
WHERE de.source = 'place_visit/v1';
