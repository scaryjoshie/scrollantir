-- migrate:up
-- Read-path views for the /today dashboard. Mirrors the canonical
-- definitions in runtime/db/schemas/70_views.sql; this migration is
-- the forward-applied copy for live DBs that booted before the
-- schema file was added.

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
      'category', p.category
    )
  END AS place
FROM public.derived_events de
LEFT JOIN public.places p
  ON p.id = NULLIF(de.data->>'place_id', '')::uuid
WHERE de.source = 'place_visit/v1';

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

GRANT SELECT ON public.v_place_visit_today TO user_role;
GRANT SELECT ON public.v_travel_leg_today  TO user_role;

-- migrate:down
DROP VIEW IF EXISTS public.v_travel_leg_today;
DROP VIEW IF EXISTS public.v_place_visit_today;
