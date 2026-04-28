# Runtime — rebuild plan (`runtime/` folder)

Forward-looking spec for the next iteration of the reasoning plane. The
current POC orchestrator (`orchestrator/` folder, Phases 0–2 shipped on
Hetzner) is treated as a successful learning artifact: it validated
agent-via-Claude-CLI + cron + bind-mount conventions, but the new shape
of work (deterministic derivers, LLM-deriver `forward`/`complete`
lifecycle, Caddy-fronted dashboard, possible future Postgres) doesn't
fit the bash-and-prompts layout cleanly.

This doc is the contract a fresh agent picks up when scaffolding
`runtime/` from scratch. Read [README.md](README.md) (the POC spec) for
historical context; this doc supersedes it for forward work.

## Status

✅ **Shipped 2026-04-27.** Runtime/ stack is live on the same Hetzner
CAX11 VM that previously ran the `orchestrator/` POC. Public ingest:
`https://ingest.178-104-253-30.nip.io` (Caddy + Let's Encrypt). Phone
+ Mac forwarder cut over and posting through the new endpoint.
Old `orchestrator/` systemd unit stopped + disabled; image archived
as `scrollantir-orchestrator:archived-2026-04-27` plus a portable
tarball at `/opt/scrollantir/archives/orchestrator-snapshot-2026-04-27.tar`.
Supabase data plane no longer receives traffic; project pending pause.

What's still pending after the cutover:

- daily-digest + weekly-report port from `orchestrator/jobs/*.md` into
  the new agent's APScheduler (the cron jobs went silent when the old
  orchestrator was stopped)
- views (commit #4 in the original migration sequence): events_enriched,
  mac_active, phone_active, idle_span, concurrent, top_apps_*,
  phone_activity_gated
- agent_api.* RPCs (commit #5): upsert_report, upsert_annotation,
  create_prompt, replace_derived_window
- first deriver implementation (place_visit/v1)
- dashboard cutover from Supabase direct-Postgres → PostgREST

The migration sequence in this doc was a useful design artifact; the
actual cutover landed in eight commits (a7c2706 → 704ad92). The
sequence below reads as the historical plan rather than a forward
checklist.

> **Earlier status update 2026-04-26:** Decision #4 below —
> *"postgres/ reserved but not populated in v1; Supabase remains the
> data plane"* — was **reversed**. `runtime/` v1 adopted the full
> self-hosted stack from [self-host.md](self-host.md) from day one.
> The internal layout also evolved — `runtime/app/` is the single
> Python image hosting both `api` (FastAPI) and `agent` (APScheduler)
> as two compose services. See
> [session-2026-04-25.md postscript](../sessions/session-2026-04-25.md#postscript--2026-04-26-self-host-pivot)
> for rationale.

## Why a fresh folder

Decided 2026-04-25 (see [session chronicle](../sessions/session-2026-04-25.md)).

The current `orchestrator/` is ~300 lines of bash + Dockerfile shaped
around three coupled assumptions: bash for the runtime glue, Claude
CLI as the only execution engine, cron as the only scheduler. The new
runtime introduces (1) a Python process with deriver modules, (2) an
in-process scheduler or polling loop for `complete()` dispatch, and
(3) Caddy for HTTPS termination + future dashboard hosting. None of
those fit cleanly into a folder whose mental model is "bash + Claude
+ cron template."

The smallness of the existing code is also load-bearing in the other
direction: there's almost nothing to lose by leaving `orchestrator/`
running unmodified for a couple of weeks while the new substrate
stabilizes. Parallel deploy → soak → swap → retire.

## End state — what `runtime/` is

A docker-compose stack on Hetzner CAX11. Currently two services
(Caddy + agent); a Postgres slot is reserved for if/when Supabase
becomes constraining (not part of v1).

```
runtime/
  docker-compose.yml         # the whole stack
  README.md                  # this folder's index (how to run, deploy, debug)
  caddy/
    Caddyfile                # config, mounted into caddy:2-alpine
  agent/
    Dockerfile               # custom Python image (ONLY service that ships its own image)
    pyproject.toml           # or requirements.txt, your call
    src/
      scrollantir_agent/
        __main__.py          # entrypoint: env-validate, pgpass, scheduler.run()
        scheduler.py         # cron-fired forward() + ~60s poll for complete()
        runner.py            # subprocess wrapper around `claude -p` for LLM jobs
        db.py                # psycopg pool, replace_window helper
        derivers/            # deterministic deriver modules
          place_visit.py
          travel_leg.py
          workout.py
        llm/                 # LLM deriver classes
          sleep.py           # forward() + complete()
        logging_setup.py
    prompts/                 # bind-mount target — was orchestrator/runtime/
      CLAUDE.md
      jobs/                  # daily-digest.md, weekly-report.md, etc.
      skills/                # empty placeholder
      .claude/settings.json
  postgres/                  # FUTURE — only populated if you migrate off Supabase
  systemd/
    runtime.service          # supervises `docker compose up`
    runtime.env.example      # secret template
  deploy.sh                  # build + push + restart on the VM
  sync-runtime.sh            # rsync prompts to bind-mount without rebuild
```

### Why one Dockerfile (in `agent/`) and not three

Dockerfile-per-service is a default that doesn't apply here. You only
need a Dockerfile when you ship custom code into the image. Caddy and
Postgres use their official images (`caddy:2-alpine`,
`postgres:16-alpine`) configured via mounted files + env vars. Only
the agent ships custom Python code, so only the agent has a Dockerfile.

### Why Caddy is in the stack now

Earns its keep as soon as the dashboard ships HTTPS. Bonus uses:
push-completion endpoint for LLM derivers (faster than 60s polling),
or in front of self-hosted Python ingest routes if Supabase is ever
retired. Today it serves the dashboard locally on dev; on the Hetzner
deploy it terminates TLS for `dashboard.<your-domain>`.

## What the agent does

Two distinct modes, both running inside the same container:

### Mode A — cron-fired `forward()` passes

Replaces the current `orchestrator/run-job.sh`. For each scheduled
deriver, the agent's scheduler invokes:

- **Deterministic deriver** → executes the SQL/algorithm, applies
  replace-window semantics (`DELETE source = '<kind>/<v>' AND start_ts
  IN [window) ; INSERT ...`), commits.
- **LLM deriver `forward()`** → computes heuristic, returns either
  rows (if confidence ≥ threshold or `confirmation_policy = 'never'`),
  prompts (writes via `agent_api.create_prompt`), or noop.
- **Report job** (daily-digest, weekly-report) → unchanged from POC:
  runs `claude -p prompts/jobs/<name>.md`, agent writes report via
  `agent_api.upsert_report`.

### Mode B — ~60s poll for `complete()` dispatch

New behavior, doesn't exist in the POC. Polls:

```sql
SELECT p.*, e.* AS answer_event
FROM public.prompts p
JOIN public.events e ON e.id = p.answer_event_id
WHERE p.answered_at IS NOT NULL
  AND p.derived_at  IS NULL
  AND p.kind = :prompt_kind
ORDER BY p.answered_at;
```

For each match, dispatches to the corresponding LLM deriver's
`complete(prompt, answer)`. Returned rows + `prompts.derived_at = NOW()`
land in a single transaction — see `data-model.md` §3 for the
canonical lifecycle.

## Derivers to ship in v1

Per `data-model.md` §4 registry, plus session-2026-04-25 additions:

| kind            | class           | inputs                                                      | cadence       | notes |
|-----------------|-----------------|-------------------------------------------------------------|---------------|-------|
| `place_visit/v1`  | Deterministic | `phone.location.reading`, `phone.activity.state`            | every 15 min  | STILL-overlap rule + per-category dwell minimum to filter pass-throughs (the dining-hall walk-under case). Reads `places` table for label resolution. |
| `travel_leg/v1`   | Deterministic | `derived.place_visit`, `phone.activity.state`               | every 15 min  | Complement of visits. Dominant activity = most-time-in-window. |
| `workout/v1`      | Deterministic | `phone.system.foreground` (workout-app pkg), `phone.activity.state`, `derived.place_visit`, `mac.system.window` | daily 23:30 | Sliding-window cadence detection inside gym visits, hard-anchored by Mac-online / vehicle-transition / gym-EXIT. See session-2026-04-25 chronicle for the rule. |
| `sleep/v1`        | LLM `if_uncertain` (≈0.85) | `mac.system.afk`, `phone.system.unlocked`, `phone.system.screen` | daily 16:00 | Already speccd in data-model.md; ports cleanly into the new runtime. |

Plus a SQL helper (not a deriver) for **phone-activity-gated** activity
spans — discards `phone.activity.state` rows whose entire span lies
inside a long phone-locked window. See session-2026-04-25 §"AFK
gating" for why this is a view, not a deriver.

## Hard prereqs (block any deriver code)

These need to land before any deriver SQL is written:

1. **`derived_events` migration** — schema is in data-model.md §1; not
   yet deployed to Supabase.
2. **`prompts.derived_at` column + partial index** for the
   `complete()` polling query.
3. **earthdistance extension** for `place_visit` matching (probably
   already available on Supabase; verify before assuming).
4. **`places` table migration** + initial seed rows. Schema in
   `concepts/places.md`.
5. **Where the runner runs** — orchestrator host vs. dashboard server
   vs. Supabase pg_cron. Pin this down before writing the first
   deriver. (The intuition is "same host as the new runtime/" —
   Hetzner. Confirm with Josh.)

## Migration sequence

Each step depends on the prior:

1. **Build `runtime/agent/` empty-skeleton** (Dockerfile + pyproject +
   src layout + a `scheduler.py` that just logs "tick" every minute).
   Verify it builds + runs locally.
2. **Add `runtime/caddy/` with a Caddyfile** that serves a placeholder.
   Verify the compose stack comes up locally.
3. **Land the schema migrations** (`derived_events`, `places`,
   `prompts.derived_at`, earthdistance).
4. **Port `daily-digest` + `weekly-report`** into agent/runner.py
   subprocess. These continue to use Claude CLI; the agent process
   just supervises the cron-fire.
5. **Implement `place_visit/v1`** as a Deterministic deriver. Backfill
   one window manually to verify; then enable the 15-min cron.
6. **Implement `travel_leg/v1`**. Same pattern.
7. **Implement `workout/v1`**. Cadence detection is the most algorithmic
   piece in v1; see session-2026-04-25 for the rule.
8. **Port `sleep/v1`** with the `forward()`/`complete()` lifecycle and
   the 60s poll loop.
9. **Soak `runtime/` on Hetzner alongside `orchestrator/`** for ~2 days.
   Monitor that report content matches and derivers fire.
10. **Swap the systemd unit + retire `orchestrator/`** in one PR.
11. **Delete `orchestrator/`** in a follow-up cleanup commit.

## What `runtime/` does NOT replace

- ~~**Supabase** stays as the data plane (events, prompts, derived_events,
  ingest edge functions, agent_api RPCs).~~ **Reversed 2026-04-26.**
  Supabase is being replaced; client cutover sequence (re-pointing
  android/ + mac-forwarder/, re-minting tokens against the local DB)
  is TBD and lands in a follow-up commit after the local stack proves
  out.
- **`dashboard/`** stays as a separate top-level folder. It will read
  via Caddy → PostgREST instead of direct Postgres TCP once cutover
  happens; codebase remains independent.
- **`android/`** and **`mac-forwarder/`** are unchanged collectors
  *for now* — they'll be re-pointed at the local ingest endpoint at
  cutover.
- **`scripts/admin.py`** stays as the local admin CLI.

## Decisions to confirm with Josh before scaffolding

The earlier discussion landed on these but they're worth a final yes
before any code:

- Folder name is `runtime/` (not `host/`, not `agent/`). ✅ confirmed 2026-04-26
- Python for the agent (not extending bash). ✅ confirmed 2026-04-26
- Caddy as a service in the compose stack from day one (vs. defer). ✅ confirmed 2026-04-26
- ~~`postgres/` reserved as a folder slot but not populated in v1
  (Supabase remains the data plane).~~ **Reversed 2026-04-26** —
  `postgres/` is populated in v1; runtime/ adopts self-host.md from
  day one (see banner above).
- Deterministic derivers ship as Python modules (vs. `*.sql` files
  invoked by psql). ✅ confirmed 2026-04-26
- Reuse the existing `orchestrator/runtime/{CLAUDE.md, jobs/, skills/}`
  prompts verbatim into `runtime/agent/prompts/`. ✅ confirmed 2026-04-26
  (path lands as `runtime/app/src/scrollantir/agent/prompts/`).

## Pointers

- [README.md](README.md) — the POC orchestrator (current production)
- [agent.md](agent.md) — `agent_role` capabilities + `agent_api.*` RPC reference
- [self-host.md](self-host.md) — host-level deploy runbook
- [../data-model.md](../data-model.md) — deriver hierarchy, registry, replace-window
- [../sessions/session-2026-04-25.md](../sessions/session-2026-04-25.md) — design decisions that shaped this plan
