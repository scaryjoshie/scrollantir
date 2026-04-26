# Scrollantir — Roadmap

A living plan. Keep this updated as pieces ship. The goal: a future
session (human or agent) can pick up the repo, read this, and know
exactly what's done, what's in flight, and what's next.

Status legend: ✅ done · 🚧 in progress · 📋 planned · 💡 idea

## What exists today

| Piece | Status | Notes |
|---|---|---|
| Android app (phone events) | ✅ | Collecting `system.foreground`, `system.screen`, `system.unlocked`, `system.unlock`, `youtube.shorts`, `instagram.reels`, `instagram.stories`, `tiktok.feed`, `detector.miss`. Sideloaded on Pixel 9. **Still posts to stub server — Supabase wire-up is #4 below.** |
| Mac forwarder | ✅ | launchd agent, reads AW via `aw-client`, **now posts to Supabase edge function** (as of 2026-04-21). Hostname-agnostic uuid5 scheme. `docs/mac.md`. |
| Zen aw-watcher-web fork | ✅ | `mac-extension/` — adds `container` field to tab events. Installed as xpi in Zen. |
| Stub ingest server | retired | `android-testing/server.py` deleted 2026-04-25 in cleanup pass. Both forwarders go to Supabase directly now. |
| Supabase project | ✅ | `feijpewzqgqczkxmvdng`. CLI linked locally. |
| Supabase schema v3 | ✅ | Deployed + three hot-patches applied 2026-04-21 (pgcrypto schema qualifier, rate-limit 200→10000, re-grant `events_enriched`). Three write surfaces: `ingest_api`, `agent_api`, user_role direct SQL. |
| Permissive RLS policies | ✅ | On all public tables, scoped to user_role + agent_role. |
| Custom Postgres roles | ✅ | `ingest_role`, `user_role`, `agent_role` now LOGIN with passwords assigned (2026-04-21 via `./admin setup-roles`). DSNs in macOS Keychain. |
| Supabase edge functions | ✅ | Three endpoints deployed with `--no-verify-jwt`: `/ingest`, `/prompt-answer`, `/pending-prompts`. `docs/edge-functions.md`. |
| Mac → Supabase ingest | ✅ | ~3400+ events landed; forwarder running on 30s interval. |
| Orchestrator Phase 0 | ✅ | Local Claude Code against Supabase wrote first daily-digest report (`reports.id c93d8d69-...`). `docs/orchestrator.md`. |
| Repo prepped for OSS | ✅ | MIT LICENSE, top-level README, personal paths scrubbed, `.claude/settings.local.json` gitignored. |

## Immediate next work (implementation)

Order matters — each step unblocks the next.

### 1. Admin CLI (`scripts/admin.py`) ✅

Shipped 2026-04-21 (commit `297307e`). `./admin` at repo root with
device add/list/rename/retire, setup-roles (ALTER ROLE WITH LOGIN +
Keychain writes), mint (QR + plaintext-once), list, revoke,
revoke-all --yes, rotate, rotate --finalize. Four Codex audit passes
before merge; acceptance sequence from `docs/admin-cli.md` not yet
run (awaits service_role DSN + explicit OK).

### 2. Ingest edge functions (`supabase/functions/*`) ✅

Shipped 2026-04-21 (commit `c933dcd`, redeployed with
`--no-verify-jwt` so device bearers reach handlers). Three endpoints
live: `/ingest`, `/prompt-answer`, `/pending-prompts`. Full details
in `docs/edge-functions.md`. Deno runtime, typed `PostgresError`
SQLSTATE mapping, bound-parameter queries, per-event loop with
short-circuit on auth/rate-limit, continue-on-error for validation.

### 3. Wire Mac forwarder to Supabase ✅

Shipped 2026-04-21 (commits `fa1e31f`, `3a8348d`). Forwarder now
posts to Supabase `/functions/v1/ingest` on 30 s launchd interval.
Config key renamed from `server_url` to `ingest_url`; UUID scheme
rewritten to `uuid5("mac:{source}:{bucket_created_at}:{aw_id}")`
so hostname drift no longer re-ingests history. Verified end-to-end:
3400+ events landed.

### 4. Wire Android app to Supabase ✅

Shipped 2026-04-21. Added a "Scan Onboarding QR" settings card
(CameraX + ML Kit barcode-scanning) that parses the `./admin mint`
v:2 payload and writes `url`, `token`, and `device_id` into
`EncryptedSharedPreferences`. Emit now stamps events with the stored
`device_id` (default `phone`). `IngestClient` uses the stored URL
verbatim — the stub-server `/ingest` suffix is no longer appended by
the client. Acceptance confirmed: phone token minted, QR scanned,
`detector.miss` / `system.foreground` / `system.unlock` /
`youtube.shorts` rows landed in `public.events` on first sync.

### 5. Documentation sweep ✅

Drift swept 2026-04-25:
- `docs/architecture.md` status table + ASCII pipeline diagram
  refreshed; Coolify references replaced with Hetzner+systemd; phone
  & mac forwarders shown going to Supabase directly; new
  `phone.location.reading` + `phone.activity.state` sources added to
  the catalog.
- `docs/data-flow.md` Coolify references removed; orchestrator block
  retitled "Docker + systemd on Hetzner CAX11"; status table updated
  to reflect Phases 0–2 shipped, dashboard pivoted to web.
- `docs/setup.md` stub-server section removed; Supabase-direct
  verification checklist replaced.
- `docs/mac.md` retitled as a component reference; status section
  marks the implementation as live with the hold-the-tail fix
  landed 2026-04-25.
- `docs/agent.md` flagged as subsumed by `orchestrator.md` with a
  banner pointing to the production runtime.
- `docs/edge-functions.md` clarified what shipped as edge functions
  (3) vs what moved to the orchestrator (daily-digest, weekly-report)
  vs what stays as pure pg_cron (token-cleanup).
- `docs/session-2026-04-23-aw-forwarder.md` postscript added: the
  AFK decision in the body was reversed once real durations flowed;
  derived-idle won.

## Next after ingest is live (agent infra)

### 6. Orchestrator — Claude Code CLI on a server 🚧

Full spec in [`docs/orchestrator.md`](runtime/README.md). Supersedes
the earlier "local Claude Code agent tooling" and "scheduled edge
functions (cron agents)" items — we consolidated both into a single
always-on container running Claude Code CLI, cron-invoked.

Runtime: Docker on Oracle Cloud Always Free ARM + Coolify.
Four-phase setup (local scratch → local Docker → VPS deploy → layer
on jobs). Credentialed as `agent_role`; writes reports via
`agent_api.upsert_report` and prompts via `agent_api.create_prompt`.

Jobs land incrementally:
- `smoke` — wiring check (phase-1 validator).
- `daily-digest` — 7am local, 24h summary. First real job.
- `weekly-report` — Sunday 9am local, 7-day deeper analysis.
- `classifier` — every 15 min once projects (#8) ships.
- `prompt-asker` — deferred; triggers + question taxonomy TBD.

Small operational jobs (auto-revoke superseded tokens, prune
rate_limit rows older than 1h) stay on Supabase `pg_cron` — they're
DB-only, no LLM, no reason to move them.

**Acceptance:** per-phase exit criteria in `docs/orchestrator.md`.
End state: cron-triggered daily-digest lands a report every morning
without human intervention, verifiable via the
`/scrollantir/memory/last-success-daily-digest` marker.

**Progress 2026-04-21:** Phases 0, 1, and 2 complete.
- **Phase 0** — first real daily-digest report by local Claude Code
  as `agent_role` (`reports.id c93d8d69-...`).
- **Phase 1** — cold-container `smoke` and `daily-digest` both
  produce reports identical in shape to Phase 0 (`reports.id
  a06e7c81-...` tag `{smoke}`; `reports.id 26862d14-...` tag
  `{daily}`). Image: ubuntu:24.04 + psql + cron + node + Claude
  Code CLI 2.1.116, 1m48s daily-digest, arm64 native.
- **Phase 2** — Hetzner CAX11 ARM (nbg1) + systemd + bind-mount at
  `/opt/scrollantir/data:/scrollantir`. Two consecutive
  cron-triggered `daily-digest` runs landed without manual
  intervention (`reports.id 4f73befe-...` tag `{daily}` via
  injected test cron, and `9dc95f82-...` from the natural
  `0 7 * * *` at 12:00 UTC). Ended up swapping Coolify for plain
  systemd — docs/orchestrator.md §Phase 2 reflects the new stack.
  **Silent-no-op bug** surfaced on first cron run and fixed:
  `run-job.sh` now `cd /scrollantir` before `claude -p` so
  project-local `.claude/settings.json` is discovered regardless
  of cron's CWD; entrypoint.sh also mirrors settings to
  `/root/.claude/settings.json` as belt-and-suspenders.

Phase 3 partially delivered same-day:
- **`weekly-report.md`** prompt shipped and test-run against
  Supabase — `reports.id 9f3dea67-...` tag `{weekly}`, 3576-char
  body. Cron line `0 9 * * 0` was already in `crontab.template`,
  so Sunday 2026-04-26 14:00 UTC will be the first production fire.
- **`classifier.md`** still blocked on roadmap #8 (projects
  schema — `projects`, `event_project_links`, `events_with_project`
  view, `agent_api.classify_event` RPC).
- **`prompt-asker.md`** still deferred — needs question taxonomy.

Phase 2 and weekly-report should soak for a few days of clean
overnight runs before Phase 3's remaining pieces get worked on.

### 7. ~~Scheduled edge functions (cron agents)~~ ❌

Superseded by #6. The reasoning was: Supabase edge functions are
short-lived, stateless, stdlib-Deno, and have no persistent
filesystem — wrong shape for an agent that accumulates skills and
memory across runs. The jobs that would have lived here
(`daily-digest`, `weekly-report`, `classifier`, `prompt-asker`) now
run inside the orchestrator container (#6). Token-cleanup and
rate_limit pruning stay on `pg_cron` since they're DB-only.

## Dashboards and projects (the "point")

### 8. Projects + event classification 📋

Full spec in [`docs/projects.md`](concepts/projects.md). Two new tables
(`projects`, `event_project_links`), one new view
(`events_with_project`), one new `agent_api.classify_event` RPC, and
a scheduled edge function that runs a cheap-LLM classifier (Groq or
Cerebras free tier) against unclassified events every 15 minutes.

This is the table we need before the dashboard can answer "time on
what" meaningfully. Cmux activity without project context is too
coarse.

**Acceptance:** see `docs/projects.md`. Dashboard query `SELECT project_name, SUM(duration_s) / 3600 AS hours FROM events_with_project WHERE timestamp_utc > NOW() - INTERVAL '7 days' GROUP BY 1` returns reasonable rollups.

### 9. Web dashboard 🚧

**Direction changed 2026-04-21.** The Swift app was parked; v1 is a
web app (Vite + React + TS) under `dashboard/`. See
[`dashboard.md`](dashboard/README.md) for the design and
[`data-model.md`](data-model.md) for the contract every dashboard
view reads from. Currently in iteration: forwarder data-correctness
work landed 2026-04-23; full architecture pass on primitives /
derivers / views in `data-model.md`. UI rebuild pending once the
foundation is settled.

### 10. Android "Questions" inbox ✅

Shipped 2026-04-21. New `QuestionsScreen` polls
`/functions/v1/pending-prompts` every 30 s while foregrounded;
`PromptsRepository` holds a process-wide `StateFlow<List<Prompt>>`
and a mutex-guarded `refresh`. The `TodayScreen` icon row gained a
question-mark button with a badge showing the unanswered count;
TodayScreen triggers a one-shot refresh on entry. Answer renderer
honors `answer_schema.type`: `number` (with optional `unit`),
`string`, `choice` (radio from `options`), free-text fallback
otherwise. Submit POSTs `{prompt_id, answer_event_id: uuid4, data}`
to `/prompt-answer` and removes the prompt from the cache on 2xx or
409 (already answered).

## Follow-ups from 2026-04-21 Codex audit

Surfaced during the audit + AFK bug investigation on the day of
first end-to-end ingest. None blocking; ordered by severity/risk.
Full context in `docs/session-2026-04-21.md`.

### FU-1. Rate-limit livelock (MUST-FIX, high severity) ✅

`ingest_api.accept_event` increments the per-minute rate counter
*before* the INSERT, so `ON CONFLICT DO NOTHING` no-op retries burn
budget. Forwarder only advances checkpoint after a full-bucket
drain. Any bucket with >10000 events backlog (a ~2-week offline
gap at this user's event rate) permanently stalls because each
retry re-consumes the budget on duplicate no-ops without progress.

Fix options (pick one or both):
- Server: skip counter increment on ON-CONFLICT no-op (cleanest)
- Client: advance `mac-forwarder/forwarder.py` checkpoint per chunk

### FU-2. AW heartbeat cascade recurrence (SHOULD-FIX, medium) ✅

AW-server's heartbeat occasionally inserts retroactive overlapping
rows with fresh aw_ids; forwarder faithfully ships them as distinct
events → Supabase duplicates at low-hundreds/month rate. Cleaned up
109 rows on 2026-04-21 via strict-containment SQL (session chronicle
has the canonical query).

Fix: forwarder-side overlap suppression in `drain_bucket` before
POST — same strict-containment logic as the cleanup SQL (collapse
same-payload overlapping events, keep longest-duration). Until then,
run the cleanup query weekly-ish.

### FU-3. Docs drift (SHOULD-FIX, medium) ✅

- `docs/architecture.md` status table + pipeline diagram still
  describe the stub-server world.
- `docs/data-flow.md` has a status table marking edge functions as
  "next" when they're live.
- `docs/README.md` + top-level `README.md` blurbs reference the
  pre-Supabase state.

One-hour sweep.

### FU-4. Migration file ordering hazard (SHOULD-FIX, low) ✅

`supabase/migrations/20260421072149_fix_pgcrypto_extensions_schema.sql`
embeds the full `accept_event` function body **with the old 200/min
rate cap**. Re-running it after `20260421073200_raise_ingest_rate_limit_to_10000.sql`
silently reverts the cap. Fix: trim `072149` to just the extension
schema change + the `extensions.digest()` call-site edits, or
update its body to the final `accept_event` version.

### FU-5. Hardcoded project ref (SHOULD-FIX, low; blocks OSS drop) ✅

`mac-forwarder/setup.sh:32` and `docs/setup.md:50,147` embed
`feijpewzqgqczkxmvdng` as the default Supabase URL. Replace with
placeholder + explicit "fill this in" line before the repo is made
public.

### FU-6. Admin CLI asymmetric base-role check (SHOULD-FIX, very low) ✅

`scripts/admin/db.py` rejects non-`postgres` base users on pooler
DSNs but not on direct DSNs. Mirror the check. UX only.

## Ideas / future bets (not blocking anything)

- **[cmux per-tab watcher](deferred/cmux-watcher.md)** — tab-level (surface) focus events for the `manaflow-ai/cmux` terminal app. Design documented; deferred 2026-04-21 because workspace-level is already captured via `system.window` titles and per-tab volume isn't worth it until a downstream consumer (classifier, focus analysis) needs it.
- **Spotify track history** — `spotify.track` events via OAuth + Supabase edge function polling
- **Calendar meetings** — Google Calendar events as `calendar.meeting` duration events
- **Wifi SSID for location context** — poor man's location without GPS
- **Terminal command history** — `terminal.command` events from shell hooks
- **Zoom meeting detection** — active-call foreground heuristic
- **Embeddings / semantic search** — pgvector + event summaries for "find weeks where I was anxious about project X"
- **Web dashboard** — if/when mobile access becomes important; would require reintroducing Supabase Auth

## Tooling / ops to think about eventually

Not urgent, capture here so we don't lose them:

- **Monitoring**: is ingest healthy? Event rate over last hour? Supabase has built-in DB stats, but a simple heartbeat dashboard would be nice.
- **Secret rotation**: how to rotate `ingest_role` password without downtime (rotate at Supabase side + update secret on function + redeploy function; ingest_role doesn't care). Write this up once we've done it once.
- **Deploy workflow**: `supabase db push` + `supabase functions deploy` are manual. Fine for personal project; worth a Makefile or `just` recipe once there are 3+ functions.
- **Backup / export**: Supabase does nightly backups on paid plans. For the free tier, a weekly `supabase db dump` to a private S3 bucket or iCloud Drive folder is cheap insurance.

## How to update this doc

When you ship a piece, move it from 📋 to ✅ here and briefly note what was delivered. When you uncover new work, add it under the appropriate section. Don't delete items — mark them ❌ with a one-line reason if they turn out to be wrong, so the reasoning is visible.
