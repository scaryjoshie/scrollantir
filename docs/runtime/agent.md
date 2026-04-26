# Scrollantir — Local agent tooling spec

> **Status:** Subsumed by [`orchestrator.md`](README.md). The
> local-Claude-Code-on-the-Mac pattern described here was the
> precursor design; the production reasoning runtime is now a Docker
> container on Hetzner CAX11 running cron-fired jobs as `agent_role`.
> This doc is retained because the `agent_role` capabilities, the
> `agent_api.*` RPC surface, and the report/annotation/prompt
> conventions all still apply (the orchestrator's `CLAUDE.md` is
> derived from the contract below). For deployment, lifecycle, and
> the actual runtime, read `orchestrator.md` first.

How a local Claude Code (or comparable) agent connects to scrollantir
data, reasons over it, and writes reports/annotations/prompts.

## Summary

The agent runs locally on the user's Mac. It connects to Supabase as
`agent_role` with credentials read from the macOS Keychain (entry
`scrollantir / agent-role`). It can:

- `SELECT` on all `public.*` tables and the `events_enriched` view
- Call the `agent_api.*` singleton functions to write reports,
  annotations, and prompts

It **cannot**:

- Write to `events`, `devices`, `source_tags`, `private.*`
- Bulk-DELETE or bulk-UPDATE anything (only singleton SECURITY DEFINER
  functions mutate, one row per call)
- Access other users' data (there are no other users)

Credentials are set up once by the user running
`scripts/admin.py setup-roles`. The agent just reads the keychain
entry each session.

## Two invocation modes

### 1. Standalone terminal

User runs Claude Code (or any agent) in a terminal from anywhere:

```
cd /path/to/scrollantir
claude
```

The agent reads `CLAUDE.md` at repo root (see below), which includes:
- Connection instructions (read the keychain entry, format a psql URL)
- The schema reference (what tables exist, what columns mean)
- Agent-write API reference (which RPCs exist, their signatures)
- Allowed operations reminder (what it can and can't do)

### 2. Spawned by the Swift Mac app

When the Swift dashboard wants analysis, it spawns a Claude Code
subprocess with `SCROLLANTIR_DB_URL` already in the environment
(read from keychain once, passed to the subprocess). The agent
doesn't need to re-read keychain.

Either way, the agent's capabilities are identical — only the
ergonomics differ.

## Required repo files

### `CLAUDE.md` at repo root

Scoped instructions that Claude Code auto-loads. Should contain:

```markdown
# Scrollantir — agent instructions

You are an analysis agent for scrollantir, a personal time-tracking
system. You have read access to the event stream, device registry,
and tag ontology. You can write reports, annotations, and prompts
via restricted RPCs.

## Connecting to the database

Read the connection string from the macOS Keychain:

  security find-generic-password -s scrollantir -a agent-role -w

Or it may already be in your env as `SCROLLANTIR_DB_URL` if spawned
by the Swift dashboard.

## What you can read

- `public.events_enriched` — primary analysis surface. One row per
  event with device label, platform, and tags attached.
- `public.events` — same but without the join (rarely needed)
- `public.devices`, `public.source_tags`, `public.reports`,
  `public.annotations`, `public.prompts`

See `docs/supabase.md` for column definitions and the event-data
shape per source.

## What you can write

Only via these functions (SECURITY DEFINER; one row per call):

- `SELECT agent_api.upsert_report(id, title, body, tags, window_start, window_end)`
  - `id` NULL = create; non-null = update an agent-originated row
- `SELECT agent_api.soft_delete_report(id)`
- `SELECT agent_api.upsert_annotation(id, scope, scope_ref, body)`
  - `scope` ∈ {`event`, `range`, `day`, `source`, `device`}
- `SELECT agent_api.soft_delete_annotation(id)`
- `SELECT agent_api.create_prompt(kind, question, context, answer_schema, expires_at, asked_by)`

## What you cannot do

- INSERT/UPDATE/DELETE on `events`, `devices`, `source_tags`
- Touch anything in the `private.*` schema
- Mass-modify: every write is one row at a time
- Drop or alter schemas
- User curation (the user reserves `source_tags` editing and hard-deletes)

## How to query efficiently

- Always scope by time: `timestamp_utc > NOW() - INTERVAL '7 days'`
- Use `events_enriched` tags array for "category of time":
  `'short_form' = ANY(tags)`
- Watch your result size; the `agent_role` has `statement_timeout = 5s`

## When to ask questions instead of guessing

If you need data the computer can't observe (sleep quality, mood,
subjective context), create a prompt via `agent_api.create_prompt`.
Answers come back as events with `source='prompt.<kind>'` and land
in the events stream for future analysis.

Keep questions short, one per prompt, with `expires_at` in 2-3 days.
Store any reasoning context in the `context` JSONB so later
analysis can reconstruct what the agent was asking about.

## Reports convention

- Title: short, timestamped, descriptive. Examples: `weekly-2026-04-20`,
  `pattern-tiktok-tuesday`, `daily-2026-04-20`
- Body: markdown. Reports render in the dashboard as-is.
- `window_start` / `window_end`: always set if the report covers a
  specific time range.
- `tags`: array. Use `daily`, `weekly`, `pattern`, `answer`, etc.
  Consistent tags make the dashboard's report list filterable.

## Annotations convention

- `scope='event'` + `scope_ref=<event UUID>` — correction on a specific event
- `scope='range'` + `scope_ref='<ISO start>/<ISO end>'` — context for a period
- `scope='day'` + `scope_ref='YYYY-MM-DD'` — day-level reflection
- `scope='source'` + `scope_ref='youtube.shorts'` — metadata about a source
```

### `scripts/agent_helper.py` (optional)

A small wrapper that Claude Code can invoke via bash:

```bash
./scripts/agent_helper.py query "SELECT SUM(duration_s) FROM events_enriched WHERE ..."
./scripts/agent_helper.py upsert-report --title X --body "..."
```

Handles the keychain read + connection pooling. The agent could also
just use `psql` directly; this is a convenience.

## Postgres MCP option

Instead of (or in addition to) the helper script, we could install
a Postgres MCP server and point Claude Code at it. Gives structured
tool calls for queries. Config in `~/.claude/settings.json` or
repo-local `.claude/settings.json`.

MCP is optional — the helper script is enough.

## Example session

```
User: "What was my short-form time trend this week?"

Agent (Claude Code):
  [runs SQL]
    SELECT date_trunc('day', timestamp_utc) as day, SUM(duration_s)/60 as minutes
    FROM events_enriched
    WHERE 'short_form' = ANY(tags) AND timestamp_utc > NOW() - INTERVAL '7 days'
    GROUP BY 1 ORDER BY 1;
  [reasons over result]
  "You averaged 32 min/day of short-form video. Thursday was the high
  at 78 min (driven by a 1-hour Instagram Reels block in the evening).
  Would you like me to write this up as a report?"

User: "yes, and make a note about Thursday"

Agent:
  [calls]
    SELECT agent_api.upsert_report(
      NULL, 'weekly-short-form-2026-04-20',
      '# Short-form this week\n\n...',
      ARRAY['weekly', 'pattern'],
      '2026-04-14 00:00:00+00', '2026-04-20 23:59:59+00'
    );
  [and]
    SELECT agent_api.upsert_annotation(
      NULL, 'day', '2026-04-18',
      'Unusual Thursday spike: 78 min short-form, 1hr Instagram block.'
    );
  "Done — report `uuid` and annotation `uuid` saved."
```

## Safeguards

The agent's `agent_role` has:

- `statement_timeout = 5s` — runaway queries die
- No access to `private.tokens` — can't see credentials
- Singleton-only writes — can't mass-modify
- Soft-delete only — hard deletes require the user via `user_role`

If the agent misbehaves (prompt injection, bad reasoning), worst case
is wasted writes to `reports` / `annotations` / `prompts`. All
recoverable via the user running `./admin` or direct SQL through
`user_role`.

## Related

- `docs/supabase.md` — full schema reference
- `docs/admin-cli.md` — how `agent_role` gets its password
- `docs/roadmap.md` — where the agent fits in the implementation plan
