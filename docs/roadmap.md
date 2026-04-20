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

Local Python script. Uses `service_role` connection string (in `~/.config/scrollantir/.env.admin`). Subcommands:

- `device add <device_id> --label "<label>" --platform <p>` → `INSERT INTO devices`
- `device list` / `device rename` / `device retire`
- `setup-roles` → assigns random passwords to `ingest_role` / `user_role` / `agent_role`, writes connection strings to Mac Keychain
- `mint --device-id <id> [--note <n>] [--show-token]` → generates 32-byte bearer, hashes, INSERTs `private.tokens`, prints plaintext + QR
- `list` (tokens) / `revoke --prefix <p>` / `revoke-all --device-id <id> --yes`
- `rotate --device-id <id>` / `rotate --device-id <id> --finalize`

Dependencies: `psycopg[binary]`, `qrcode`, `keyring`. ~200-300 lines.

**Acceptance:** mint a token for `mac`, see it in `list`, revoke it, confirm revoked. Roles have passwords and their connection strings are in Keychain.

### 2. Ingest edge function (`supabase/functions/ingest/index.ts`) 📋

TypeScript, runs on Supabase Edge Runtime (Deno). Connects to DB as `ingest_role` using connection string stored in Supabase secrets (via `supabase secrets set INGEST_DATABASE_URL=...`).

Three HTTP endpoints (separate function files or one router):

- `POST /ingest` — bearer auth, calls `ingest_api.accept_event(...)`. Body: single event or array (we chunk server-side if array).
- `POST /prompt-answer` — bearer auth, calls `ingest_api.accept_prompt_answer(...)`.
- `GET /pending-prompts` — bearer auth, calls `ingest_api.pending_prompts(...)`.

Deploys via `supabase functions deploy ingest`. ~60-80 lines of TS.

**Acceptance:** Mac forwarder's existing stub-server call swapped to the edge function URL with a real bearer. Events appear in `events` table via `SELECT * FROM events_enriched LIMIT 10`.

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

The Swift app (future) will spawn Claude Code with `agent_role` credentials, but even before the app exists, we can run Claude Code manually with the credentials. What's needed:

- A `CLAUDE.md` at repo root with instructions for the agent role — "you can SELECT from events_enriched; write reports via `SELECT agent_api.upsert_report(...)`; ask questions via `agent_api.create_prompt(...)`; never touch private.*"
- A small Postgres MCP server config so Claude Code can query directly, OR a `scripts/agent_sql.py` helper that wraps `psycopg` + reads the `agent_role` keychain entry
- Example prompts: "summarize yesterday," "find patterns this week"

**Acceptance:** Claude Code session produces a report stored in `reports` table.

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

New schema (will be its own migration):

- `public.projects` — `(id UUID PK, slug TEXT UNIQUE, name TEXT, description TEXT, keywords TEXT[], color, archived_at, lifecycle)`. User-curated via `user_role` UI or admin CLI; agent proposes via reports.
- `public.event_project_links` — `(event_id FK, project_id FK, confidence REAL, classified_by TEXT, classified_at TIMESTAMPTZ)`. Many-to-many: an event can belong to >1 project.
- `public.events_with_project` view — `events_enriched` ⋈ `event_project_links` ⋈ `projects`.

Classification edge function (cron, ~15 min):

- Pulls events WHERE no existing classification AND `app IN ('cmux','zen','Terminal',...)`
- Sends a batch to cheap LLM (Cerebras/Groq) with prompt "given these event titles and the following project definitions, classify each into a project id or null"
- INSERTs into `event_project_links`

Agent can also ask clarifying questions via `create_prompt('project_context', 'What is scrollantir about?')` when it needs to refine the taxonomy.

**Acceptance:** dashboard can show `SELECT project_name, SUM(duration_s) FROM events_with_project GROUP BY 1 WHERE day = today`.

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
