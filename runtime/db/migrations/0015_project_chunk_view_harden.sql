-- migrate:up
--
-- v_project_chunk_today: restore project display name (Tenet 10), drop the
-- category coercion (soft tree model — chunk category is the truth).
--
-- Per-row payload includes a SLIM project object: slug + name only. The
-- earlier draft dropped the entire project object for wire savings, but
-- the dashboard needs `name` to render display labels (the user named
-- their project "Scrollantir," not `scrollantir`). `description` and
-- `archived` stay out of the per-row payload — dashboard fetches them
-- once from /projects when needed (api.ts fetchProjects).

CREATE OR REPLACE VIEW public.v_project_chunk_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,
  de.end_ts,
  jsonb_build_object(
    'project_slug', NULLIF(de.data->>'project_slug', ''),
    'category',     COALESCE(NULLIF(de.data->>'category', ''), 'neutral'),
    'device',       de.data->>'device',
    'app',          de.data->>'app',
    'title',        de.data->>'title',
    'classified',   COALESCE((de.data->>'classified')::boolean, false),
    'overridden',   COALESCE((de.data->>'overridden')::boolean, false)
  ) AS data,
  CASE
    WHEN p.slug IS NULL THEN NULL
    ELSE jsonb_build_object(
      'slug', p.slug,
      'name', p.name
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
-- Restore the strict-IFF view from the earlier 0015 draft (with category
-- coercion + dropped project object).
CREATE OR REPLACE VIEW public.v_project_chunk_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,
  de.end_ts,
  jsonb_build_object(
    'project_slug', NULLIF(de.data->>'project_slug', ''),
    'category',     CASE
                      WHEN NULLIF(de.data->>'project_slug', '') IS NOT NULL
                        THEN 'work'
                      ELSE COALESCE(NULLIF(de.data->>'category', ''), 'neutral')
                    END,
    'device',       de.data->>'device',
    'app',          de.data->>'app',
    'title',        de.data->>'title',
    'classified',   COALESCE((de.data->>'classified')::boolean, false),
    'overridden',   COALESCE((de.data->>'overridden')::boolean, false)
  ) AS data,
  parent.id AS parent_id,
  COALESCE(
    NULLIF(de.data->>'project_slug', ''),
    NULLIF(de.data->>'app', ''),
    'untitled'
  ) AS topic
FROM public.derived_events de
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
