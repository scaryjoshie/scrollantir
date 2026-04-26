# Scrollantir — Projects + event classification spec

The missing layer for "time on what." Raw events have `app` and
`title`, but work happens across multiple Cmux workspaces, browser
tabs, and editors that all map to the same physical "app." The
classification layer ties raw events to user-defined **projects** so
the dashboard can answer "how much time did I spend on Project X
this week."

Not yet implemented. This doc is the design.

## The problem

| Event data | What you want to see |
|---|---|
| `{app: "cmux", title: "scrollantir/supabase.md"}` | `project: scrollantir` |
| `{app: "cmux", title: "climate-closet/api/...)"}` | `project: climate-closet` |
| `{app: "Zen", title: "PR #142 — scrollantir", container: "Work"}` | `project: scrollantir` |
| `{app: "Xcode", title: "ScrollantirKit/..."}` | `project: scrollantir` |
| `{app: "cmux", title: "bash -- misc"}` | `project: personal` (fallback) |

The raw `app` field is too coarse; `title` contains enough signal
but needs classification.

## New tables

### `public.projects`

User-curated list of projects. The user (via the dashboard UI or
admin CLI) creates and renames these. The agent can *propose* new
projects via reports; the user decides.

```sql
CREATE TABLE public.projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT UNIQUE NOT NULL,         -- 'scrollantir', 'climate-closet', 'personal'
  name         TEXT NOT NULL,                -- 'Scrollantir'
  description  TEXT,                         -- what the project is (fed to the classifier)
  keywords     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],  -- hints: ['cmux', 'supabase', 'docs/']
  color        TEXT,                         -- '#7a3' for dashboard display
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at  TIMESTAMPTZ,

  CONSTRAINT projects_slug_nonempty CHECK (length(btrim(slug)) > 0),
  CONSTRAINT projects_slug_format   CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT projects_name_nonempty CHECK (length(btrim(name)) > 0)
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_role_all_projects   ON public.projects FOR ALL    TO user_role  USING (true) WITH CHECK (true);
CREATE POLICY agent_role_read_projects ON public.projects FOR SELECT TO agent_role USING (true);
```

### `public.event_project_links`

Many-to-many: one event can match more than one project (Xcode
session for scrollantir-swift also tagged as `ios-dev`, e.g.).

```sql
CREATE TABLE public.event_project_links (
  event_id        UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES public.projects(id),
  confidence      REAL NOT NULL,                  -- 0.0..1.0 from the classifier
  classified_by   TEXT NOT NULL,                  -- 'rule.keyword' | 'agent.llm' | 'user.manual'
  classified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (event_id, project_id),
  CONSTRAINT epl_confidence_range CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX event_project_links_project ON public.event_project_links (project_id);

ALTER TABLE public.event_project_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_role_all_epl   ON public.event_project_links FOR ALL    TO user_role  USING (true) WITH CHECK (true);
CREATE POLICY agent_role_read_epl ON public.event_project_links FOR SELECT TO agent_role USING (true);
```

## Enriched view

```sql
CREATE VIEW public.events_with_project
  WITH (security_invoker = true)
AS
SELECT
  e.*,
  p.id   AS project_id,
  p.slug AS project_slug,
  p.name AS project_name,
  p.color AS project_color,
  epl.confidence,
  epl.classified_by
FROM public.events_enriched e
LEFT JOIN public.event_project_links epl ON epl.event_id = e.id
LEFT JOIN public.projects p ON p.id = epl.project_id;
```

Events with no classification come through with NULL project fields.

## agent_api extensions

```sql
-- Agent proposes new projects via reports; user curates. Agent
-- classifies events one at a time via a singleton RPC.

CREATE OR REPLACE FUNCTION agent_api.classify_event(
  p_event_id    UUID,
  p_project_id  UUID,
  p_confidence  REAL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.event_project_links (event_id, project_id, confidence, classified_by)
  VALUES (p_event_id, p_project_id, p_confidence, 'agent.llm')
  ON CONFLICT (event_id, project_id)
    DO UPDATE SET confidence = EXCLUDED.confidence,
                  classified_at = NOW(),
                  classified_by = 'agent.llm';
END
$$;

GRANT EXECUTE ON FUNCTION agent_api.classify_event(UUID, UUID, REAL) TO agent_role;
```

## Classifier edge function (scheduled, ~15 min)

`supabase/functions/classify-events/index.ts`. Runs via pg_cron.

Flow:

1. Pull up to 500 unclassified events from the last 24h that match
   "classifiable" sources (cmux, window activity with a title, etc).
2. Pull all non-archived projects (id, slug, description, keywords).
3. Build a prompt: "Given these event titles and these project definitions,
   classify each event into a project slug or null. Respond in JSON."
4. Call cheap LLM (Groq with Llama 3.1 70b or Cerebras's free tier) —
   fast inference is more important than deep reasoning for classification.
5. Parse response; for each event where classifier returned a valid slug:
   `agent_api.classify_event(event_id, project_id, confidence)`.
6. Log batch stats (`{classified: 342, skipped: 80, errors: 3}`).

Cron:

```sql
SELECT cron.schedule(
  'classify-events',
  '*/15 * * * *',
  $$SELECT net.http_post(
    url := 'https://<ref>.supabase.co/functions/v1/classify-events',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret'))
  )$$
);
```

## Why cheap LLMs are fine here

Classification is not subtle. A title like "scrollantir/supabase.md"
maps trivially to `scrollantir`; "climate-closet/backend/..." is
`climate-closet`; "bash -- general" is `personal`. The hard cases
(ambiguous titles, cross-project work) are rare, and when the
classifier is uncertain (low confidence), the user can fix up in the
dashboard.

Use **Groq** or **Cerebras** free tier:
- Groq: `llama-3.1-70b-versatile`, ~500 tokens/sec, free tier has
  high enough rate limits for ~500 events every 15 min
- Cerebras: similar throughput, even cheaper

Fall back to Anthropic `claude-haiku-4-5` if quota blown.

## User flow

### Initial setup

1. User creates projects via the dashboard UI (or `admin project add`):
   ```
   ./admin project add scrollantir --name "Scrollantir" \
     --description "Personal time-tracker built across Mac + Android + Supabase" \
     --keywords scrollantir,supabase,mac-forwarder,android \
     --color "#7a3"
   ```
2. User creates a `personal` catchall project.
3. Classifier starts running on the next cron tick.

### Agent asking clarifying questions

When the classifier sees a cluster of events it can't cleanly
classify (e.g., unknown Cmux workspace name appears repeatedly),
it can create a prompt:

```
  SELECT agent_api.create_prompt(
    'project_identification',
    'I see cmux sessions with title like "plinko/game.js" that don''t match any project. What''s Plinko?',
    '{"example_titles": ["plinko/game.js", "plinko/README.md"], "event_count": 47}'::jsonb,
    NULL,
    NOW() + INTERVAL '3 days'
  );
```

User answers via phone (or dashboard): "Plinko is a weekend side project."
Agent then proposes creating a new `plinko` project in its next report.

### Dashboard queries

```sql
-- Time per project this week
SELECT project_name, SUM(duration_s) / 3600 AS hours
FROM events_with_project
WHERE timestamp_utc > NOW() - INTERVAL '7 days'
  AND device_platform = 'macos'
GROUP BY project_name
ORDER BY hours DESC;

-- "On scrollantir" events, by source
SELECT source, SUM(duration_s) / 60 AS minutes
FROM events_with_project
WHERE project_slug = 'scrollantir'
  AND timestamp_utc > NOW() - INTERVAL '1 day'
GROUP BY source
ORDER BY minutes DESC;

-- Unclassified work time (gap)
SELECT source, data->>'title' AS title, SUM(duration_s)/60 AS minutes
FROM events_with_project
WHERE project_id IS NULL
  AND device_platform = 'macos'
  AND timestamp_utc > NOW() - INTERVAL '7 days'
  AND duration_s > 60
GROUP BY 1,2
ORDER BY minutes DESC
LIMIT 20;
```

## Open design questions

- **Should classifications survive project renames?** If you rename
  `scrollantir` → `scr`, existing links still point to the project
  UUID, so queries keep working. Renames update `slug`/`name`, links
  stay.
- **Should we classify non-Mac events?** Phone events don't have the
  same project signal (Instagram is Instagram, not "work"). Skip for
  v1.
- **What about low-confidence classifications?** Keep them; dashboard
  can filter `WHERE confidence > 0.7` to show only confident matches,
  or show both with a visual indicator.
- **Re-classification of old events on project change?** When a new
  project is added, old events' titles might match. Option: a
  backfill command in admin CLI that classifies all unclassified
  events from the last N days.

## Acceptance

1. `./admin project add scrollantir --name "Scrollantir" --description ...`
2. Wait 15 min (or trigger manually): `SELECT net.http_get(url := '.../classify-events')`.
3. `SELECT project_name, COUNT(*) FROM events_with_project WHERE timestamp_utc > NOW() - INTERVAL '1 day' GROUP BY 1`.
4. Reasonable classifications appear. Unclassified events show `NULL`.
5. Agent-initiated prompt for an unknown cluster of events fires within 1-2 days of a new workflow appearing.

## Related

- `docs/supabase.md` — base schema
- `docs/edge-functions.md` — scheduled function pattern
- `docs/agent.md` — agent's write surface (this adds classify_event)
- `docs/roadmap.md` — #8 in the sequence (after ingest live, before dashboard)
