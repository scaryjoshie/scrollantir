-- migrate:up
-- Re-create v_place_visit_today with the place's centroid_lat/lng
-- exposed in the `place` jsonb. Dashboard uses these to highlight
-- the actual building extrusion (POI centroid is inside the
-- polygon; visit stay-centroid is usually at the entrance, outside).

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
      'id',       p.id,
      'name',     p.name,
      'category', COALESCE(p.category, 'mixed')
    )
  END AS place
FROM public.derived_events de
LEFT JOIN public.places p
  ON p.id = NULLIF(de.data->>'place_id', '')::uuid
WHERE de.source = 'place_visit/v1';
