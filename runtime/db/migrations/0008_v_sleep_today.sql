-- migrate:up
-- Read-path view for the sleep/v1 deriver. The dashboard uses the
-- previous night's row to set the day's wake-time boundary
-- (replacing the static 04:00 cutoff). Each row's [start_ts, end_ts]
-- IS the sleep span — start_ts = sleep onset, end_ts = wake.

CREATE OR REPLACE VIEW public.v_sleep_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,                       -- sleep onset (UTC)
  de.end_ts,                         -- wake (UTC)
  jsonb_build_object(
    'confidence',       (de.data->>'confidence')::float8,
    -- Wake date in the user's local TZ (computed by the deriver).
    -- Lets the dashboard filter "last night's sleep" without
    -- re-doing TZ math on the client.
    'wake_local_date',  de.data->>'wake_local_date'
  ) AS data,
  jsonb_build_object(
    'disrupted_count',  COALESCE((de.provenance->>'disrupted_count')::int, 0),
    'duration_hours',   (de.provenance->>'duration_hours')::float8,
    'wake_local_time',  de.provenance->>'wake_local_time'
  ) AS provenance
FROM public.derived_events de
WHERE de.source = 'sleep/v1';

GRANT SELECT ON public.v_sleep_today TO user_role;

-- migrate:down
DROP VIEW IF EXISTS public.v_sleep_today;
