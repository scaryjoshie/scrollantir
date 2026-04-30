-- migrate:up
--
-- Two changes to v_project_chunk_today:
--
--   1. HARDEN the tree-model invariant on the read path: when
--      `project_slug` is non-null, coerce category to 'work'. The
--      0014 CHECK constraint covers `window_titles`, but old
--      derived_events JSONB rows might still have a stale
--      (slug, neutral) pair until they're re-derived. This view
--      ensures the dashboard never sees the bad combination.
--
--   2. SLIM the wire payload: drop the per-row `project` JSONB
--      object. The dashboard fetches the `projects` table once per
--      session and joins client-side via project_slug. ~40% wire
--      savings on the chunks payload, on top of the gzip win.
--
-- The view's `data` JSONB still includes `project_slug`, `category`,
-- `device`, `app`, `title`. The dashboard's TopicChunk type plumbs
-- these through directly.

CREATE OR REPLACE VIEW public.v_project_chunk_today AS
SELECT
  de.id,
  de.source,
  de.start_ts,
  de.end_ts,
  jsonb_build_object(
    'project_slug', NULLIF(de.data->>'project_slug', ''),
    -- Coerce: project_slug present → category=work. Otherwise pass
    -- through, defaulting empty/missing to 'neutral'.
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
  -- topic still drives chunk-detail header; project_slug → app → 'untitled'
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


-- migrate:down
-- Restore the previous view body (inline with the per-row project
-- object + uncoerced category). Verbatim from migration 0013.

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
