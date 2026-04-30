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


-- =========================================================================
-- v_daily_summary — per local-date aggregates for /summary + /trends.
--
-- Hardcoded TZ: America/Chicago. Mirrors the sleep deriver. When TZ
-- becomes settings-driven, change one place: this view.
--
-- "Free time" formula (a4f5bba): awake_s − (work_effective_s + neutral_effective_s).
-- Play counts as free. Floored at zero.
--
-- Mac-precedence: phone time only counts during minutes when no Mac
-- chunk overlaps. Naïve overlap-sum is correct here because the mac
-- window-tracker emits one chunk at a time (verified: 0 mac↔mac
-- overlaps in the live cache). If that invariant ever breaks, this
-- view needs to merge mac intervals before subtracting.
-- =========================================================================

CREATE OR REPLACE VIEW public.v_daily_summary AS
WITH
  dates AS (
    SELECT DISTINCT d AS local_date FROM (
      SELECT (start_ts AT TIME ZONE 'America/Chicago')::date AS d
        FROM public.derived_events
       WHERE source IN ('project_chunk/v1', 'user_active/v1', 'place_visit/v1', 'travel_leg/v1')
      UNION
      SELECT (data->>'wake_local_date')::date AS d
        FROM public.derived_events
       WHERE source = 'sleep/v1' AND data->>'kind' = 'night'
    ) s WHERE d IS NOT NULL
  ),
  day_ranges AS (
    SELECT
      local_date,
      tstzrange(
        (local_date::timestamp AT TIME ZONE 'America/Chicago'),
        ((local_date + 1)::timestamp AT TIME ZONE 'America/Chicago'),
        '[)'
      ) AS rng
    FROM dates
  ),
  mac_chunks AS (
    SELECT
      ((de.start_ts + (de.end_ts - de.start_ts) / 2) AT TIME ZONE 'America/Chicago')::date AS local_date,
      tstzrange(de.start_ts, de.end_ts, '[)') AS rng,
      EXTRACT(EPOCH FROM (de.end_ts - de.start_ts)) AS dur_s,
      de.data->>'category' AS category
    FROM public.derived_events de
    WHERE de.source = 'project_chunk/v1' AND de.data->>'device' = 'mac'
  ),
  phone_chunks AS (
    SELECT
      ((de.start_ts + (de.end_ts - de.start_ts) / 2) AT TIME ZONE 'America/Chicago')::date AS local_date,
      tstzrange(de.start_ts, de.end_ts, '[)') AS rng,
      EXTRACT(EPOCH FROM (de.end_ts - de.start_ts)) AS dur_s,
      de.id,
      de.data->>'category' AS category
    FROM public.derived_events de
    WHERE de.source = 'project_chunk/v1' AND de.data->>'device' = 'phone'
  ),
  phone_overlap AS (
    SELECT
      pc.id, pc.local_date, pc.dur_s, pc.category,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (
          upper(pc.rng * mc.rng) - lower(pc.rng * mc.rng)
        ))
      ), 0) AS overlap_s
    FROM phone_chunks pc
    LEFT JOIN mac_chunks mc ON mc.rng && pc.rng
    GROUP BY pc.id, pc.local_date, pc.dur_s, pc.category
  ),
  phone_effective AS (
    SELECT local_date, category, dur_s, GREATEST(0, dur_s - overlap_s) AS eff_s
    FROM phone_overlap
  ),
  effective_by_cat AS (
    SELECT local_date, category, SUM(dur_s) AS eff_s FROM mac_chunks GROUP BY local_date, category
    UNION ALL
    SELECT local_date, category, SUM(eff_s) AS eff_s FROM phone_effective GROUP BY local_date, category
  ),
  category_totals AS (
    SELECT
      local_date,
      COALESCE(SUM(eff_s) FILTER (WHERE category = 'work'),    0)::int AS work_effective_s,
      COALESCE(SUM(eff_s) FILTER (WHERE category = 'play'),    0)::int AS play_effective_s,
      COALESCE(SUM(eff_s) FILTER (WHERE category = 'neutral'), 0)::int AS neutral_effective_s
    FROM effective_by_cat
    GROUP BY local_date
  ),
  device_totals AS (
    SELECT
      local_date,
      COALESCE(SUM(dur_s) FILTER (WHERE src = 'mac'),       0)::int AS mac_active_s,
      COALESCE(SUM(dur_s) FILTER (WHERE src = 'phone_raw'), 0)::int AS phone_active_s,
      COALESCE(SUM(dur_s) FILTER (WHERE src = 'phone_eff'), 0)::int AS phone_effective_s
    FROM (
      SELECT local_date, dur_s, 'mac'::text AS src FROM mac_chunks
      UNION ALL
      SELECT local_date, dur_s, 'phone_raw'::text AS src FROM phone_effective
      UNION ALL
      SELECT local_date, eff_s AS dur_s, 'phone_eff'::text AS src FROM phone_effective
    ) s
    GROUP BY local_date
  ),
  awake_clipped AS (
    SELECT
      dr.local_date,
      EXTRACT(EPOCH FROM (
        upper(dr.rng * tstzrange(de.start_ts, de.end_ts, '[)'))
        - lower(dr.rng * tstzrange(de.start_ts, de.end_ts, '[)'))
      )) AS awake_s,
      de.start_ts, de.end_ts
    FROM day_ranges dr
    JOIN public.derived_events de
      ON de.source = 'user_active/v1'
     AND tstzrange(de.start_ts, de.end_ts, '[)') && dr.rng
  ),
  awake_totals AS (
    SELECT
      local_date,
      COALESCE(SUM(awake_s), 0)::int AS awake_s,
      MIN(start_ts) AS first_active_ts,
      MAX(end_ts)   AS last_active_ts
    FROM awake_clipped
    GROUP BY local_date
  ),
  visits_per_day AS (
    SELECT
      ((de.start_ts + (de.end_ts - de.start_ts) / 2) AT TIME ZONE 'America/Chicago')::date AS local_date,
      de.data->>'place_id' AS place_id
    FROM public.derived_events de
    WHERE de.source = 'place_visit/v1'
  ),
  visit_totals AS (
    SELECT local_date, COUNT(*)::int AS place_visit_count, COUNT(DISTINCT place_id)::int AS distinct_places
    FROM visits_per_day GROUP BY local_date
  ),
  legs_per_day AS (
    SELECT
      ((de.start_ts + (de.end_ts - de.start_ts) / 2) AT TIME ZONE 'America/Chicago')::date AS local_date,
      (de.data->>'distance_m')::float8 AS distance_m
    FROM public.derived_events de
    WHERE de.source = 'travel_leg/v1'
  ),
  leg_totals AS (
    SELECT local_date, COALESCE(SUM(distance_m), 0)::float8 AS travel_distance_m
    FROM legs_per_day GROUP BY local_date
  ),
  sleep_per_day AS (
    SELECT
      (de.data->>'wake_local_date')::date AS local_date,
      EXTRACT(EPOCH FROM (de.end_ts - de.start_ts))::int AS sleep_s,
      COALESCE((de.provenance->>'disrupted_count')::int, 0) AS disrupted_count
    FROM public.derived_events de
    WHERE de.source = 'sleep/v1' AND de.data->>'kind' = 'night'
  ),
  sleep_totals AS (
    SELECT local_date,
           COALESCE(SUM(sleep_s), 0)::int AS sleep_main_s,
           COALESCE(MAX(disrupted_count), 0) AS sleep_disrupted_count
    FROM sleep_per_day GROUP BY local_date
  )
SELECT
  d.local_date,
  COALESCE(at.awake_s, 0)               AS awake_s,
  COALESCE(dt.mac_active_s, 0)          AS mac_active_s,
  COALESCE(dt.phone_active_s, 0)        AS phone_active_s,
  COALESCE(dt.phone_effective_s, 0)     AS phone_effective_s,
  COALESCE(ct.work_effective_s, 0)      AS work_effective_s,
  COALESCE(ct.play_effective_s, 0)      AS play_effective_s,
  COALESCE(ct.neutral_effective_s, 0)   AS neutral_effective_s,
  GREATEST(
    0,
    COALESCE(at.awake_s, 0)
      - COALESCE(ct.work_effective_s, 0)
      - COALESCE(ct.neutral_effective_s, 0)
  )                                     AS free_s,
  COALESCE(st.sleep_main_s, 0)          AS sleep_main_s,
  COALESCE(st.sleep_disrupted_count, 0) AS sleep_disrupted_count,
  COALESCE(vt.place_visit_count, 0)     AS place_visit_count,
  COALESCE(vt.distinct_places, 0)       AS distinct_places,
  COALESCE(lt.travel_distance_m, 0)     AS travel_distance_m,
  at.first_active_ts,
  at.last_active_ts
FROM dates d
LEFT JOIN awake_totals    at ON at.local_date = d.local_date
LEFT JOIN device_totals   dt ON dt.local_date = d.local_date
LEFT JOIN category_totals ct ON ct.local_date = d.local_date
LEFT JOIN visit_totals    vt ON vt.local_date = d.local_date
LEFT JOIN leg_totals      lt ON lt.local_date = d.local_date
LEFT JOIN sleep_totals    st ON st.local_date = d.local_date;


-- =========================================================================
-- v_project_activity — per (local_date, project_slug) totals.
-- Chunks with NULL project_slug are excluded — the dashboard derives
-- "non-project" time as (category total - sum of project totals).
-- =========================================================================

CREATE OR REPLACE VIEW public.v_project_activity AS
WITH
  mac_chunks AS (
    SELECT
      ((de.start_ts + (de.end_ts - de.start_ts) / 2) AT TIME ZONE 'America/Chicago')::date AS local_date,
      tstzrange(de.start_ts, de.end_ts, '[)') AS rng,
      EXTRACT(EPOCH FROM (de.end_ts - de.start_ts)) AS dur_s,
      NULLIF(de.data->>'project_slug', '') AS project_slug,
      de.id
    FROM public.derived_events de
    WHERE de.source = 'project_chunk/v1' AND de.data->>'device' = 'mac'
  ),
  phone_chunks AS (
    SELECT
      ((de.start_ts + (de.end_ts - de.start_ts) / 2) AT TIME ZONE 'America/Chicago')::date AS local_date,
      tstzrange(de.start_ts, de.end_ts, '[)') AS rng,
      EXTRACT(EPOCH FROM (de.end_ts - de.start_ts)) AS dur_s,
      NULLIF(de.data->>'project_slug', '') AS project_slug,
      de.id
    FROM public.derived_events de
    WHERE de.source = 'project_chunk/v1' AND de.data->>'device' = 'phone'
  ),
  phone_overlap AS (
    SELECT pc.id, pc.local_date, pc.project_slug, pc.dur_s,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (
          upper(pc.rng * mc.rng) - lower(pc.rng * mc.rng)
        ))
      ), 0) AS overlap_s
    FROM phone_chunks pc
    LEFT JOIN mac_chunks mc ON mc.rng && pc.rng
    GROUP BY pc.id, pc.local_date, pc.project_slug, pc.dur_s
  ),
  per_chunk AS (
    SELECT local_date, project_slug, dur_s AS eff_s FROM mac_chunks
    UNION ALL
    SELECT local_date, project_slug, GREATEST(0, dur_s - overlap_s) AS eff_s FROM phone_overlap
  )
SELECT
  pc.local_date,
  pc.project_slug,
  p.name AS project_name,
  SUM(pc.eff_s)::int AS total_s,
  COUNT(*)::int      AS chunk_count
FROM per_chunk pc
LEFT JOIN public.projects p ON p.slug = pc.project_slug
WHERE pc.project_slug IS NOT NULL
  AND pc.eff_s > 0
GROUP BY pc.local_date, pc.project_slug, p.name;


-- Grants: user_role reads via PostgREST.
GRANT SELECT ON public.v_place_visit_today   TO user_role;
GRANT SELECT ON public.v_travel_leg_today    TO user_role;
GRANT SELECT ON public.v_sleep_today         TO user_role;
GRANT SELECT ON public.v_user_active_today   TO user_role;
GRANT SELECT ON public.v_project_chunk_today TO user_role;
GRANT SELECT ON public.v_daily_summary       TO user_role;
GRANT SELECT ON public.v_project_activity    TO user_role;
