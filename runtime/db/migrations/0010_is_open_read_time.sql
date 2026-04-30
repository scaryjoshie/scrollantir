-- migrate:up
-- Move `is_open` from write-time deriver state to read-time view
-- computation. The deriver no longer writes `is_open` into data.
--
-- Old behavior: place_visit/v1 deriver tagged the latest emitted row
-- with is_open=true if its end_ts was within 30 min of the deriver
-- window end. Frozen at write time → stuck "currently here" forever
-- if the agent crashed; no way to refresh without re-emitting that
-- specific row, which only happened on ticks where its start_ts was
-- still in window.
--
-- New behavior: is_open is computed against NOW() in the view. A
-- visit is open iff its end_ts is the latest (across all
-- place_visit/v1 rows) AND that end_ts is within 30 min of NOW().
-- Stale rows naturally close themselves the moment NOW() drifts past
-- the threshold; agent crashes can't strand the flag.

CREATE OR REPLACE VIEW public.v_place_visit_today AS
WITH latest AS (
  SELECT MAX(end_ts) AS max_end_ts
    FROM public.derived_events
   WHERE source = 'place_visit/v1'
)
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
    -- is_open: only the row with the global-max end_ts can be open,
    -- and only if that end_ts is within 30 min of NOW().
    'is_open',          (
      de.end_ts = (SELECT max_end_ts FROM latest)
      AND (NOW() - de.end_ts) <= INTERVAL '30 minutes'
    )
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
