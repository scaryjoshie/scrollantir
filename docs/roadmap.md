# Scrollantir — Roadmap

A living plan. Keep this updated as pieces ship. The goal: a future
session (human or agent) can pick up the repo, read this, and know
exactly what's done, what's in flight, and what's next.

Status legend: ✅ done · 🚧 in progress · 📋 planned · 💡 idea

## What exists today

| Piece | Status | Notes |
|---|---|---|
| Android app (phone events) | ✅ | Collecting `system.foreground`, `system.screen`, `system.unlocked`, `system.unlock`, `youtube.shorts`, `instagram.reels`, `instagram.stories`, `tiktok.feed`, `detector.miss`. Sideloaded on Pixel 9. Posts to stub server (not yet Supabase). |
| Mac forwarder | ✅ | launchd agent, reads AW via `aw-client`, posts to stub server. `docs/mac.md`. |
| Zen aw-watcher-web fork | ✅ | `mac-extension/` — adds `container` field to tab events. Installed as xpi in Zen. |
| Stub ingest server | ✅ | `android-testing/server.py` — dev-only, LAN, bearer `dev-token`. |
| Supabase project | ✅ | `feijpewzqgqczkxmvdng`. CLI linked locally. |
| Supabase schema v3 | ✅ | Deployed. See `docs/supabase.md`. Three write surfaces: `ingest_api`, `agent_api`, user_role direct SQL. |
| Permissive RLS policies | ✅ | On all public tables, scoped to user_role + agent_role. |
| Custom Postgres roles | ✅ | `ingest_role`, `user_role`, `agent_role` created NOLOGIN. Passwords not yet assigned. |

## Immediate next work (implementation)

Order matters — each step unblocks the next.

### 1. Admin CLI (`scripts/admin.py`) 📋

Full spec in [`docs/admin-cli.md`](admin-cli.md). Local Python tool for:
- Device registry (`device add` / `list` / `rename` / `retire`)
- Role setup (`setup-roles` — one-time, assigns passwords to custom roles, writes to Keychain)
- Token lifecycle (`mint` with QR output, `list`, `revoke`, `rotate`, `rotate --finalize`)

~200-300 lines Python. `psycopg`, `keyring`, `qrcode`, `click`.

**Acceptance:** see `docs/admin-cli.md` — specific command sequence.

### 2. Ingest edge functions (`supabase/functions/*`) 📋

Full spec in [`docs/edge-functions.md`](edge-functions.md). Three
functions for v1 ingest:

- `POST /functions/v1/ingest` — events (calls `ingest_api.accept_event`)
- `POST /functions/v1/prompt-answer` — prompt answers
- `GET /functions/v1/pending-prompts` — phone polling

Each ~40-80 lines TS. Connects as `ingest_role` via `INGEST_DATABASE_URL`
secret. Never uses `service_role`.

**Acceptance:** see `docs/edge-functions.md` — curl tests + real forwarder wire-up.

### 3. Wire Mac forwarder to Supabase 📋

Change `mac-forwarder/setup.sh` to prompt for the Supabase edge function URL + minted bearer. Update `forwarder.py` config path if needed. Re-run setup.sh, verify events flow.

**Acceptance:** `~/Library/Logs/scrollantir-forwarder.out.log` shows successful POSTs to `<ref>.supabase.co/functions/v1/ingest`. Events visible in Supabase dashboard.

### 4. Wire Android app to Supabase 📋

Update the app's "Server URL" setting to accept the Supabase edge function URL + new bearer (via QR scan). Requires:

- Update Android app's ingest URL format if needed
- New "Scan Onboarding QR" setting screen (CameraX, parse JSON from `admin mint`'s QR)
- Stored in `EncryptedSharedPreferences`

**Acceptance:** phone events appear in `events` table.

### 5. Documentation sweep 📋

Update:
- `docs/setup.md` — replace stub-server section with Supabase setup runbook
- `docs/architecture.md` — update the pipeline diagram to show Supabase instead of FastAPI/stub
- `docs/android.md` — note the new QR onboarding flow once implemented

## Next after ingest is live (agent infra)

### 6. Local Claude Code agent tooling 📋

Full spec in [`docs/agent.md`](agent.md). Repo-root `CLAUDE.md` with
agent instructions, connection pattern (Keychain read), schema
reference, conventions for reports/annotations/prompts. Optional
`scripts/agent_helper.py` or Postgres MCP for ergonomic queries.

**Acceptance:** Claude Code session writes a `report` via `agent_api.upsert_report`, shows up in `SELECT * FROM reports ORDER BY created_at DESC`.

### 7. Scheduled edge functions (cron agents) 📋

Via `pg_cron` scheduling `net.http_post` to new edge functions:

- `daily-digest` — runs at 7am, pulls last 24h of events, calls an LLM provider (Cerebras/Groq free tier for speed, fall back to Anthropic), drafts a short `report` and stores.
- `weekly-report` — runs Sundays at 9am, similar but 7-day window and deeper analysis.
- `prompt-asker` — runs at configurable triggers (e.g., nightly at 10pm) to ask low-friction questions (sleep latency, mood).
- `token-cleanup` — hourly: revoke superseded tokens older than 48h; delete rate_limit rows older than 1h.

Anthropic/Cerebras/Groq API keys stored as Supabase function secrets.

**Acceptance:** daily digest appears in `reports` every morning.

## Dashboards and projects (the "point")

### 8. Projects + event classification 📋

Full spec in [`docs/projects.md`](projects.md). Two new tables
(`projects`, `event_project_links`), one new view
(`events_with_project`), one new `agent_api.classify_event` RPC, and
a scheduled edge function that runs a cheap-LLM classifier (Groq or
Cerebras free tier) against unclassified events every 15 minutes.

This is the table we need before the dashboard can answer "time on
what" meaningfully. Cmux activity without project context is too
coarse.

**Acceptance:** see `docs/projects.md`. Dashboard query `SELECT project_name, SUM(duration_s) / 3600 AS hours FROM events_with_project WHERE timestamp_utc > NOW() - INTERVAL '7 days' GROUP BY 1` returns reasonable rollups.

### 9. Swift Mac dashboard 📋

Native app. Reads Supabase directly with `user_role` credentials (Keychain). Key surfaces:

- **Today view** — real-time time-on-app, short-form totals, Mac-vs-phone active time. Reads from `events_enriched`.
- **Project view** — time per project via `events_with_project`. Bar charts.
- **Reports inbox** — recent `reports`, daily digest, weekly summary. Read-only display with option to "open in editor" for user edits.
- **Chat with agent** — Swift-native chat window that spawns Claude Code subprocess with `agent_role` credentials, shows streaming output, lets agent call tools.
- **Terminal wrapper** — simple embedded terminal for invoking the admin CLI inline.

Tech stack likely: SwiftUI + `supabase-swift`. Keychain items: `scrollantir/user-role`, `scrollantir/agent-role`.

**Acceptance:** you can open the app, see today's summary, ask the agent a question and get a response grounded in your real data.

### 10. Android "Questions" inbox 📋

New screen in the phone app:

- Subscribes to (or polls every 30s) `/functions/v1/pending-prompts`
- Shows unanswered prompts with their questions
- Answer-entry UI respects `prompts.answer_schema` (number + unit, free text, multiple choice)
- On submit: POST to `/prompt-answer`

**Acceptance:** agent asks a question at 10pm, phone shows it, you answer in the morning, it becomes an event.

## Ideas / future bets (not blocking anything)

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
