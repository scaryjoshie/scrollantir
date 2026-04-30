-- migrate:up
-- Adds v_user_active_today (a read-path view for the new
-- user_active/v1 deriver) and updates v_sleep_today to expose the
-- new `kind` field ('night' | 'nap'). The sleep deriver was
-- refactored to depend on user_active and to classify each row as
-- night vs nap; the dashboard uses `kind='night'` rows to set the
-- day boundary, naps render as Moments inside the day.
--
-- This migration also wipes any existing sleep/v1 rows so the new
-- id scheme (uuid5 on wake_local_date+kind+rank) doesn't collide
-- with the previous scheme. There were no production sleep rows
-- yet, so this is a no-op on the live DB; included for any dev
-- DBs that ran the prior migration.

DELETE FROM public.derived_events WHERE source = 'sleep/v1';

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

GRANT SELECT ON public.v_user_active_today TO user_role;

CREATE OR REPLACE VIEW public.v_sleep_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,                       -- sleep onset (UTC)
  de.end_ts,                         -- wake (UTC)
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

-- migrate:down
DROP VIEW IF EXISTS public.v_sleep_today;
DROP VIEW IF EXISTS public.v_user_active_today;

CREATE OR REPLACE VIEW public.v_sleep_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,
  de.end_ts,
  jsonb_build_object(
    'confidence',      (de.data->>'confidence')::float8,
    'wake_local_date', de.data->>'wake_local_date'
  ) AS data,
  jsonb_build_object(
    'disrupted_count', COALESCE((de.provenance->>'disrupted_count')::int, 0),
    'duration_hours',  (de.provenance->>'duration_hours')::float8,
    'wake_local_time', de.provenance->>'wake_local_time'
  ) AS provenance
FROM public.derived_events de
WHERE de.source = 'sleep/v1';

GRANT SELECT ON public.v_sleep_today TO user_role;
