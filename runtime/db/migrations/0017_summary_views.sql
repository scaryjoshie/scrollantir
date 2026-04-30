-- migrate:up
--
-- Read-path views for the /summary (at-a-glance) and /trends pages.
--
-- v_daily_summary       — one row per local-date (America/Chicago)
-- v_project_activity    — one row per (local-date, project_slug)
--
-- Both views are computed-on-read against derived_events. No deriver,
-- no materialization. Volume is single-user and trivial (3 sources
-- aggregated; 2k rows per day max), so a sequential pass per page
-- load is fine. If the data set grows past ~100 days, consider a
-- materialized view refreshed nightly.
--
-- DESIGN NOTES
-- ============
--
-- "Local date" everywhere means the date in the user's TZ. Hardcoded
-- to America/Chicago — the existing sleep deriver hardcodes the same
-- string (TODO.md "TZ-aware deriver thresholds"). Whenever that
-- becomes settings-driven, change one place: this file. Don't add a
-- second hardcoded TZ.
--
-- Mac-precedence: phone time only counts during minutes when no Mac
-- chunk overlaps. Implemented via tstzrange intersection — for each
-- phone chunk we subtract the total overlap duration with the merged
-- mac-chunk range. Identical math to DetailPane.tsx::macPrecedence,
-- moved server-side so /summary and /today report the same numbers.
--
-- "Free time" follows a4f5bba's recommendation:
--   free_s = awake_s − (work_effective_s + neutral_effective_s)
-- Play counts as free. awake_s comes from user_active/v1 union over
-- the day (clipped to local-date boundaries).
--
-- HONESTY: no fabrication. Days with no project_chunk rows return
-- 0 for chunk-derived columns; the dashboard renders "Tracking gap"
-- when awake_s is also 0. Dropping such rows would violate Tenet 1.

-- =========================================================================
-- v_daily_summary
-- =========================================================================
--
-- Output columns (all per local_date):
--   local_date                 DATE        — America/Chicago calendar date
--   awake_s                    INTEGER     — user_active/v1 union, clipped
--   mac_active_s               INTEGER     — sum of mac project_chunks
--   phone_active_s             INTEGER     — sum of phone project_chunks (raw)
--   phone_effective_s          INTEGER     — mac-precedence applied
--   work_effective_s           INTEGER     — work category, mac-precedence
--   play_effective_s           INTEGER     — play category, mac-precedence
--   neutral_effective_s        INTEGER     — neutral category, mac-precedence
--   free_s                     INTEGER     — awake − (work + neutral)
--   sleep_main_s               INTEGER     — sleep/v1 night, anchored at wake
--   sleep_disrupted_count      INTEGER     — provenance.disrupted_count
--   place_visit_count          INTEGER     — visits whose midpoint is in date
--   distinct_places            INTEGER     — distinct place_id in those visits
--   travel_distance_m          DOUBLE PRECISION — sum of travel_leg distances
--   first_active_ts            TIMESTAMPTZ — earliest user_active start
--   last_active_ts             TIMESTAMPTZ — latest user_active end
--
-- Anchoring conventions:
--   project_chunk → midpoint falls in [date 00:00, date+1 00:00) local
--   place_visit   → same (midpoint anchor, so a visit spanning midnight
--                   counts on the day where most of it occurred)
--   travel_leg    → midpoint
--   sleep night   → data->>'wake_local_date' (matches dashboard convention)
--   user_active   → range intersection, clipped to date window

CREATE OR REPLACE VIEW public.v_daily_summary AS
WITH
  -- Date spine: every local-date that appears in any source. Avoids
  -- gaps from inactive days but doesn't fabricate days that never
  -- existed in the data.
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
  -- Local-day windows as tstzrange — used for clip/overlap math below.
  -- Computed once per date.
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
  -- Mac chunk ranges + their midpoint-anchored local-date.
  -- Mac chunks are emitted by the foreground window-tracker, which
  -- only ever has ONE chunk active at a time — they don't overlap
  -- each other. (Verified 2026-04-30 against the live cache: 0
  -- pairs of overlapping mac chunks.) That assumption lets the
  -- naïve-sum overlap math below be correct without a merge-then-
  -- intersect step.
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
  -- For each phone chunk, the total overlap with mac chunks. Joined
  -- by range overlap directly (NOT by local_date) — a phone chunk
  -- around midnight can be midpoint-anchored to date X while overlap-
  -- ping a mac chunk anchored to date Y. Restricting by local_date
  -- would silently skip those cases, inflating phone_effective_s.
  --
  -- Mac chunks don't overlap each other (verified above), so summing
  -- per-mac-chunk overlap is safe — no double-count of shared
  -- regions.
  phone_overlap AS (
    SELECT
      pc.id,
      pc.local_date,
      pc.dur_s,
      pc.category,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (
          upper(pc.rng * mc.rng) - lower(pc.rng * mc.rng)
        ))
      ), 0) AS overlap_s
    FROM phone_chunks pc
    LEFT JOIN mac_chunks mc ON mc.rng && pc.rng
    GROUP BY pc.id, pc.local_date, pc.dur_s, pc.category
  ),
  -- Effective seconds per phone chunk: full duration minus overlap,
  -- floored at zero.
  phone_effective AS (
    SELECT
      local_date,
      category,
      dur_s,
      GREATEST(0, dur_s - overlap_s) AS eff_s
    FROM phone_overlap
  ),
  -- Aggregate mac and phone effective into a single per-date,
  -- per-category effective-seconds pool.
  effective_by_cat AS (
    SELECT local_date, category, SUM(dur_s) AS eff_s
      FROM mac_chunks
     GROUP BY local_date, category
    UNION ALL
    SELECT local_date, category, SUM(eff_s) AS eff_s
      FROM phone_effective
     GROUP BY local_date, category
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
  -- Awake time: union of user_active/v1 ranges, clipped to the local
  -- day window. Sources='both' / 'mac' / 'phone' all count — any device
  -- saw the user as active.
  awake_clipped AS (
    SELECT
      dr.local_date,
      EXTRACT(EPOCH FROM (
        upper(dr.rng * tstzrange(de.start_ts, de.end_ts, '[)'))
        - lower(dr.rng * tstzrange(de.start_ts, de.end_ts, '[)'))
      )) AS awake_s,
      de.start_ts,
      de.end_ts
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
  -- Place visits anchored to local-date by midpoint.
  visits_per_day AS (
    SELECT
      ((de.start_ts + (de.end_ts - de.start_ts) / 2) AT TIME ZONE 'America/Chicago')::date AS local_date,
      de.data->>'place_id' AS place_id
    FROM public.derived_events de
    WHERE de.source = 'place_visit/v1'
  ),
  visit_totals AS (
    SELECT
      local_date,
      COUNT(*)::int                     AS place_visit_count,
      COUNT(DISTINCT place_id)::int     AS distinct_places
    FROM visits_per_day
    GROUP BY local_date
  ),
  -- Travel legs anchored to local-date by midpoint.
  legs_per_day AS (
    SELECT
      ((de.start_ts + (de.end_ts - de.start_ts) / 2) AT TIME ZONE 'America/Chicago')::date AS local_date,
      (de.data->>'distance_m')::float8 AS distance_m
    FROM public.derived_events de
    WHERE de.source = 'travel_leg/v1'
  ),
  leg_totals AS (
    SELECT
      local_date,
      COALESCE(SUM(distance_m), 0)::float8 AS travel_distance_m
    FROM legs_per_day
    GROUP BY local_date
  ),
  -- Sleep anchored to wake_local_date (the convention used by
  -- v_sleep_today and the /today page).
  sleep_per_day AS (
    SELECT
      (de.data->>'wake_local_date')::date AS local_date,
      EXTRACT(EPOCH FROM (de.end_ts - de.start_ts))::int AS sleep_s,
      COALESCE((de.provenance->>'disrupted_count')::int, 0) AS disrupted_count
    FROM public.derived_events de
    WHERE de.source = 'sleep/v1'
      AND de.data->>'kind' = 'night'
  ),
  sleep_totals AS (
    -- One night per local_date in steady state. SUM/MAX collapse the
    -- (rare) case of two qualifying rows.
    SELECT
      local_date,
      COALESCE(SUM(sleep_s), 0)::int   AS sleep_main_s,
      COALESCE(MAX(disrupted_count), 0) AS sleep_disrupted_count
    FROM sleep_per_day
    GROUP BY local_date
  )
SELECT
  d.local_date,
  COALESCE(at.awake_s, 0)                AS awake_s,
  COALESCE(dt.mac_active_s, 0)           AS mac_active_s,
  COALESCE(dt.phone_active_s, 0)         AS phone_active_s,
  COALESCE(dt.phone_effective_s, 0)      AS phone_effective_s,
  COALESCE(ct.work_effective_s, 0)       AS work_effective_s,
  COALESCE(ct.play_effective_s, 0)       AS play_effective_s,
  COALESCE(ct.neutral_effective_s, 0)    AS neutral_effective_s,
  -- Free = awake − (work + neutral). Play counts as free.
  -- Floored at zero for the (rare) case where category sums exceed
  -- awake_s due to range edge-cases (chunk start before first active).
  GREATEST(
    0,
    COALESCE(at.awake_s, 0)
      - COALESCE(ct.work_effective_s, 0)
      - COALESCE(ct.neutral_effective_s, 0)
  )                                      AS free_s,
  COALESCE(st.sleep_main_s, 0)           AS sleep_main_s,
  COALESCE(st.sleep_disrupted_count, 0)  AS sleep_disrupted_count,
  COALESCE(vt.place_visit_count, 0)      AS place_visit_count,
  COALESCE(vt.distinct_places, 0)        AS distinct_places,
  COALESCE(lt.travel_distance_m, 0)      AS travel_distance_m,
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
-- v_project_activity — per (local_date, project_slug) totals
-- =========================================================================
--
-- Output columns:
--   local_date     DATE
--   project_slug   TEXT      — joins to public.projects
--   project_name   TEXT      — curated display name (Tenet 10)
--   total_s        INTEGER   — mac-precedence applied
--   chunk_count    INTEGER
--
-- Chunks with NULL project_slug are excluded — they're "no project,"
-- not a project named NULL. The dashboard's "non-project" time is
-- derived from category totals minus project totals.

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
    SELECT
      pc.id,
      pc.local_date,
      pc.project_slug,
      pc.dur_s,
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
    SELECT local_date, project_slug, GREATEST(0, dur_s - overlap_s) AS eff_s
      FROM phone_overlap
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


-- =========================================================================
-- Grants
-- =========================================================================

GRANT SELECT ON public.v_daily_summary    TO user_role;
GRANT SELECT ON public.v_project_activity TO user_role;


-- migrate:down
DROP VIEW IF EXISTS public.v_project_activity;
DROP VIEW IF EXISTS public.v_daily_summary;
