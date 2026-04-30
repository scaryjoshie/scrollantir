-- migrate:up
-- Read-path view + supporting index for project_chunk/v1 derived rows.
--
-- The dashboard renders project_chunk rows nested under their containing
-- place_visit/travel_leg ("topic chunks"). Computing parent_id server-
-- side (LATERAL against [start_ts, end_ts] containing the chunk midpoint)
-- avoids round-tripping every chunk through the dashboard's overlap
-- math; chunks that fall in a gap (no GPS coverage / pre-onboarding)
-- expose parent_id = NULL and the dashboard renders them at the top
-- level.
--
-- Hardening:
--   - WHERE source='project_chunk/v1' is the only filter — pending /
--     unclassified rows still surface so the dashboard can render them
--     in a "classifying..." state.
--   - category COALESCE(NULLIF(... in ('work','play','neutral')), 'neutral')
--     keeps rendering robust if the LLM ever emits an unexpected value.
--   - topic = first non-empty of project_slug, app; fallback 'untitled'.
--
-- Index: a partial index on (start_ts, end_ts) restricted to project_chunk/v1
-- accelerates both the source filter and the LATERAL containment join.

CREATE INDEX IF NOT EXISTS derived_events_project_chunk_span
  ON public.derived_events (start_ts, end_ts)
  WHERE source = 'project_chunk/v1';


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


GRANT SELECT ON public.v_project_chunk_today TO user_role;


-- migrate:down
DROP VIEW IF EXISTS public.v_project_chunk_today;
DROP INDEX IF EXISTS public.derived_events_project_chunk_span;
