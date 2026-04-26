# Scrollantir orchestrator (container runtime)

You are the scrollantir orchestrator agent, running inside a Docker
container on an always-on VPS. Cron invokes you via `run-job.sh <job>`,
which calls `claude -p "$(cat /scrollantir/jobs/<job>.md)"`. One job
per run; you write one report (or annotation / prompt) and exit.

## How you connect

`$AGENT_DATABASE_URL` is in the environment (inherited from cron).
The password is also written to `~/.pgpass` (mode 600) by the
container entrypoint, so `psql` never prompts. Default query:

    psql "$AGENT_DATABASE_URL" -c "SELECT ..."

Quick health check:

    psql "$AGENT_DATABASE_URL" -c "SELECT current_user, NOW()"

You should see `agent_role` and the current UTC timestamp. The role
has `statement_timeout = 5s` — every query must be bounded (`LIMIT`
+ time-window filter).

## What you can read

Everything in `public.*` via SELECT. Canonical surfaces:

- **`public.events_enriched`** (view) — the LLM-friendly read surface.
  Events joined with device metadata and `source_tags` rolled up to an
  array. Use this by default.
- `public.events`, `public.devices`, `public.source_tags`
- `public.reports`, `public.annotations`, `public.prompts`

## What you can write (singleton RPCs only)

Direct INSERT/UPDATE/DELETE on tables will fail with "permission
denied" — that's the trust boundary. All writes go through
`agent_api.*` functions, one row at a time:

```sql
-- create a new report (pass NULL as id):
SELECT agent_api.upsert_report(
  NULL,                                       -- id (NULL = new)
  'Daily digest 2026-04-21',                  -- title
  '<markdown body>',                          -- body
  ARRAY['daily'],                             -- tags
  NOW() - INTERVAL '24 hours',                -- window_start
  NOW()                                       -- window_end
);

-- update an existing report (pass its id):
SELECT agent_api.upsert_report(
  '<existing-id>', '...new title...', '...new body...',
  ARRAY['daily'], '<window_start>', '<window_end>'
);

-- scoped note ('event' | 'time_range' | 'source' | 'device' | 'day'):
SELECT agent_api.upsert_annotation(
  NULL, 'time_range',
  '2026-04-21T01:10Z/2026-04-21T08:30Z',
  'Inferred sleep window (user-confirmed via prompt)'
);

-- ask the user a question (they'll see it on the phone):
SELECT agent_api.create_prompt(
  'sleep_latency',
  'How long did you take to fall asleep last night?',
  '{"trigger": "nightly"}'::jsonb,
  '{"type": "number", "unit": "minutes"}'::jsonb,
  NOW() + INTERVAL '2 days',
  'agent.orchestrator'
);

-- soft-delete (sets deleted_at):
SELECT agent_api.soft_delete_report('<id>');
SELECT agent_api.soft_delete_annotation('<id>');
```

## Filesystem layout

`/scrollantir` is a persistent volume that survives container
redeploys. Tree:

- `CLAUDE.md` — this file.
- `jobs/*.md` — job prompts (invoked by `run-job.sh <job>`).
- `skills/` — reusable snippets and notes. If `skills/README.md`
  exists, read it for the inventory before writing new helpers.
  On a fresh container the directory is empty — that's expected.
- `memory/` — agent-written state across runs. Key files:
  - `memory/log.md` — one line per job run, appended by `run-job.sh`
    on success or failure. Don't write here yourself; the per-run
    `logs/<job>-<utc>.log` captures everything you print to stdout
    (including returned UUIDs), which is where detail belongs.
  - `memory/baselines.md` — if you generate baselines, write them
    here so future runs can compare.
  - `memory/last-success-<job>` — single-timestamp healthcheck files.
    Do not write these yourself; `run-job.sh` owns them.
  - `memory/errors-<UTC-date>.md` — write here if a job fails
    mid-way and surface what went wrong.
- `logs/` — per-run log files (`<job>-<utc>.log`). Written by
  `run-job.sh`; you don't need to touch these.

## Conventions

- Reports: markdown body, sectioned (`## Summary`, `## Where time
  went`, etc.). Tag `['daily']` for daily-digest, `['weekly']` for
  weekly-report, `['smoke']` for smoke tests.
- Prompts: write `context` JSON that explains *why* you're asking so
  the user's next session (or the phone UI) has context.
- Timestamps: the container runs in America/Chicago, but all DB
  timestamps (`timestamp_utc`, `received_at`) are UTC. Report titles
  can use local date (`Daily digest 2026-04-21`); ranges in report
  bodies should be explicit about TZ.

## What NOT to do

- Don't try to modify `public.events` directly — append-only from
  ingest. If an event looks wrong, write an annotation explaining
  why rather than altering history.
- Don't write to `public.source_tags` — user-curated, not agent
  territory.
- Don't hard-delete anything; soft-delete RPCs flip `deleted_at`.
- Don't echo `$AGENT_DATABASE_URL` into log files, reports, or other
  output. It contains the password inline.
- Don't assume identity from context (Color3 workspace ≠ Color3
  project). Project attribution is the classifier's job (roadmap
  #8), not yours — until that layer exists, report *observed facts*
  and their workspace/app/URL/title context, not derived claims.
- Don't guess your way through an error. If a query fails, write
  what happened to `memory/errors-<UTC-date>.md` and exit non-zero
  so the failure surfaces in `memory/log.md` and the next run's
  `last-success` marker is stale.
