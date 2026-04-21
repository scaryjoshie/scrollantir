# Scrollantir — Architecture

Personal "palantir for yourself" time-tracking. Structured events across Mac and Android, owned end-to-end, queryable like a real database.

## Status

| Component | State |
|---|---|
| Android app (phone data) | ✅ Built, running on Pixel 9. **Still posts to the LAN stub server**; Supabase wire-up is roadmap #4. |
| Mac collector (ActivityWatch + forwarder) | ✅ launchd agent on 30 s interval, posting to Supabase. |
| Ingest pipeline (Supabase edge functions → Postgres) | ✅ `/ingest`, `/prompt-answer`, `/pending-prompts` live. Event row count in the thousands and growing. |
| Admin CLI (`./admin`) | ✅ Device/token/role lifecycle. |
| Orchestrator (Claude Code CLI) | 🚧 Phase 0 validated locally; Phases 1–3 (container → Oracle Free + Coolify → add jobs) planned. |
| Stub ingest server (dev-only) | ✅ Still usable for LAN-only debugging; not the primary path anymore. |
| Dashboard (Swift Mac app) | 📋 Planned; blocked on roadmap #8 (projects/classification). |

## Goals

- Know where time actually goes across Mac and Android
- Distinguish *which* tab / workspace / YouTube mode, not just "Chrome" or "YouTube"
- Resolve ambiguity between "on Mac" and "on phone with Mac open in front of me"
- Own the data. No SaaS lock-in. Postgres is the system of record.

## Non-goals

- Screen recording / OCR. Too heavy, too invasive.
- iOS tracking. Apple's sandboxing makes it infeasible at the granularity we want.
- Multi-user. Architected for one.
- Real-time dashboards. 15-minute forwarding latency is fine.
- In-app metadata extraction in v1 (video titles, channels). Deferred.

## System diagram

```
PHONE (Android 14+, Pixel 9)                     MAC
┌────────────────────────────┐                   ┌────────────────────────────┐
│ TrackerForegroundService   │                   │ ActivityWatch (menu bar)   │
│ ├─ UsageStatsPoller        │                   │ ├─ aw-watcher-window       │
│ ├─ ScreenWatcher           │                   │ ├─ aw-watcher-afk          │
│ ├─ ContentDetectorService  │                   │ └─ aw-watcher-web (fork)   │
│ │    (AccessibilityService)│                   │                            │
│ └─ Room DB (local queue)   │                   │ Python forwarder (launchd) │
│                            │                   │   reads AW's local SQLite, │
│ ForwarderWorker (15m)      │                   │   runs every 30s           │
│ CleanupWorker (6h)         │                   │                            │
└──────────────┬─────────────┘                   └──────────────┬─────────────┘
               │                                                │
               │  HTTPS + bearer                  HTTPS + bearer │
               │  [stub for now;                                 │
               │   roadmap #4 →                                  │
               │   Supabase edge]                                │
               │                                                 │
               ▼                                                 ▼
     ┌──────────────────┐             ┌──────────────────────────────────┐
     │ android-testing/ │             │ Supabase edge function           │
     │ server.py        │             │ POST /functions/v1/ingest        │
     │ (LAN stub, dev)  │             │ (Deno, --no-verify-jwt)          │
     └──────────────────┘             │           ↓                      │
                                      │ ingest_api.accept_event          │
                                      │ (SECURITY DEFINER, ingest_role)  │
                                      │           ↓                      │
                                      │ public.events                    │
                                      │ ON CONFLICT (id) DO NOTHING      │
                                      └──────────────┬───────────────────┘
                                                     │
                                                     ▼
                             ┌────────────────────────────────────────┐
                             │ Orchestrator (planned)                 │
                             │ Claude Code CLI + cron + Docker        │
                             │ Oracle Free ARM + Coolify              │
                             │ Reads via agent_role, writes reports   │
                             │ via agent_api.upsert_report            │
                             └────────────────────────────────────────┘
                                                     ▼
                                          ┌───────────────────┐
                                          │ Swift dashboard   │
                                          │ (planned)         │
                                          └───────────────────┘
```

See `docs/data-flow.md` for the cross-plane credential map and
per-arrow operation detail. This diagram is the bird's-eye view;
data-flow.md is the runtime placement.

## Data model

Every event — every source, both platforms — has the same shape:

```json
{
  "id": "uuid-v4",
  "device": "phone",
  "source": "youtube.shorts",
  "timestamp": "2026-04-20T14:23:01.000Z",
  "duration_s": 47.2,
  "data": {}
}
```

Fields:

- `id` — UUID v4. Clients generate. Server uses for `ON CONFLICT (id) DO NOTHING` idempotency.
- `device` — `phone`, `mac`, etc. Own column, indexed alongside source.
- `source` — `{namespace}.{specifier}`. See "Source naming" below.
- `timestamp` — start of the event's window. UTC ISO-8601 with `Z`.
- `duration_s` — seconds, float. `0` for point events.
- `data` — small JSON object, schema fixed per source. May be `{}`.

The `(device, source)` pair identifies a logical stream. Schema of `data` is stable within one stream.

### Source naming — three-level hierarchy

`{device}.{namespace}.{specifier}`. `device` is broken out as its own column but logically the leftmost level.

- **namespace** = `system` for OS-level watchers; app name (lowercased) for in-app detectors.
- **specifier** = the specific stream within that namespace.

| device | source                  | Type | What | Data fields |
|--------|-------------------------|------|------|---|
| phone  | `system.foreground`     | dur  | Per-app foreground session | `{"app": "<package>"}` |
| phone  | `system.screen`         | dur  | Raw screen-on span | `{"state": "on"}` |
| phone  | `system.unlocked`       | dur  | User-actually-using-phone span | `{}` |
| phone  | `system.unlock`         | pt   | Unlock action | `{}` |
| phone  | `youtube.shorts`        | dur  | YouTube in Shorts view | `{}` |
| phone  | `instagram.reels`       | dur  | Instagram in Reels view | `{}` |
| phone  | `instagram.stories`     | dur  | Instagram in Stories view | `{}` |
| phone  | `tiktok.feed`           | dur  | TikTok (whole app is feed) | `{}` |
| phone  | `detector.miss`         | pt   | Target app foregrounded, no rule matched | `{"package", "view_ids"}` |
| mac    | `system.window`         | dur  | Frontmost app + window title | `{"app", "title"}` |
| mac    | `system.afk`            | dur  | Active / idle | `{"status": "afk" \| "not-afk"}` |
| mac    | `zen.tab`               | dur  | Zen tab URL/title/container | `{"url", "title", "container", "audible", "incognito"}` |

*dur = duration event, pt = point event (`duration_s = 0`).*

### Source vs. data vs. tags — what belongs where

- **source**: a stable identifier for the stream. Picked at the lowest level that's stable across app versions (`youtube.shorts` is stable; `reel_recycler` resource ID is not).
- **data**: facts specific to this row that aren't already in the source name. Tab URL, package name, screen state.
- **source_tags** (separate server-side table): cross-cutting categorizations that may change over time. "short_form", "social_feed", "productive" — all tags, not sources.

> The events table stores what we observed. The `source_tags` table stores what we think it means. They're decoupled so interpretation can change without rewriting history.

### Source tags (server-side ontology)

```sql
CREATE TABLE source_tags (
  device TEXT NOT NULL,
  source TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (device, source, tag)
);

-- Seeded on deploy
INSERT INTO source_tags VALUES
  ('phone', 'youtube.shorts',   'short_form'),
  ('phone', 'instagram.reels',  'short_form'),
  ('phone', 'tiktok.feed',      'short_form'),
  ('phone', 'instagram.feed',   'social_feed'),
  ('phone', 'instagram.reels',  'social_feed'),
  ('phone', 'instagram.stories','social_feed');
```

Query "short-form video time this week":

```sql
SELECT SUM(e.duration_s)
FROM events e
JOIN source_tags t USING (device, source)
WHERE t.tag = 'short_form'
  AND e.timestamp_utc > NOW() - INTERVAL '7 days';
```

### Point vs. duration events

Both use the same schema. Point events have `duration_s: 0`. Same table, same ingest path, same ID scheme. Duration events tell you how time was spent; point events tell you behavioral patterns (context-switching frequency, unlock count).

### Timestamp discipline

- Always UTC on the wire. `Instant.now().toString()` (Kotlin), `datetime.now(timezone.utc).isoformat()` (Python).
- Store as `TIMESTAMPTZ` in Postgres.
- Render in local time at the dashboard layer.

## Collection pattern (Pattern B)

> Track state in memory. Emit a completed event when the state changes.

Not heartbeats. Not start/stop signals. The watcher holds "currently X since T" in process memory, and on transition: emit `{source, start: T, duration: now - T, data}`, set current = Y, T = now.

Works because foreground service signals (ACTIVITY_RESUMED/PAUSED, SCREEN_ON/OFF, AW's own events) give clean transitions. The forwarder's durable queue provides crash resilience at a different layer.

## Store-and-forward on the phone

Every device has a durable local SQLite buffer. The Android app uses Room:

```kotlin
@Entity(tableName = "events")
data class EventRow(
    @PrimaryKey val id: String,           // UUID v4
    val device: String,                    // "phone"
    val source: String,                    // "system.foreground", "youtube.shorts", etc.
    @ColumnInfo(name = "timestamp_utc") val timestampUtc: String,
    @ColumnInfo(name = "duration_s") val durationS: Double,
    @ColumnInfo(name = "data_json") val dataJson: String,
    @ColumnInfo(name = "forwarded_at") val forwardedAt: String? = null
)
```

Forwarder loop (`ForwarderWorker`, 15-min periodic via WorkManager):

1. `SELECT * WHERE forwarded_at IS NULL ORDER BY timestamp_utc ASC LIMIT 500`
2. POST batch to server with `Authorization: Bearer <token>`
3. On `2xx`: `UPDATE events SET forwarded_at = now WHERE id IN (:ids)`
4. On `4xx` (except 408/429): return `Result.success()` *without* marking forwarded — preserves queue, backs off instead of infinite retries on bad token
5. On `5xx` / `408` / `429` / IO error: `Result.retry()` with exponential backoff

`CleanupWorker` (6-hour periodic) deletes rows where `forwarded_at IS NOT NULL AND forwarded_at < now - 48h`. Local retention window enables Today-dashboard aggregation across server outages.

### Idempotency

Server-side:

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,           -- matches client UUID
  device TEXT NOT NULL,
  source TEXT NOT NULL,
  timestamp_utc TIMESTAMPTZ NOT NULL,
  duration_s REAL NOT NULL,
  data JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX events_device_source_time ON events (device, source, timestamp_utc);
```

Insert: `ON CONFLICT (id) DO NOTHING`. Retry after a lost-response is a no-op — zero duplicates.

### Mac's different

Mac doesn't own the local SQLite — ActivityWatch does. The Mac forwarder polls AW's DB with a per-bucket rowid checkpoint (no in-place mutation of AW's table), and synthesizes deterministic UUIDs via `uuid5(NAMESPACE_URL, f"{aw_bucket_id}:{aw_row_id}")` so retries produce the same UUID and the server dedupes identically.

## Mac-vs-phone disambiguation

With data flowing from both devices, the dashboard can resolve "was I actually on my Mac, or just had it open while scrolling my phone":

```
active_mac   = (mac.system.afk status=not-afk) ∩ (mac.system.window exists)
active_phone = phone.system.unlocked

both        = active_mac ∩ active_phone        -- doomscrolling next to laptop
mac_only    = active_mac - active_phone        -- actually working
phone_only  = active_phone - active_mac        -- actually on phone
```

`system.unlocked` (not `system.screen`) is the correct signal — glancing at the lock screen doesn't count.

## Principles recap

- **Own the data.** No SaaS. Events land in own Postgres.
- **Local-first collection.** Every device has a durable queue. Forwarders are the only thing touching the network.
- **One shape for all events.** `{id, device, source, timestamp, duration_s, data}`. Simpler queries, simpler ingest.
- **Source = stable raw fact, tags = ontology.** Events never re-interpreted. "Short form" is a tag joined at query time, not a source name.
- **Pattern B collection.** Track state in memory, emit completed event on change. No heartbeats on the wire.
- **Lightweight.** No screen recording, no OCR, no always-on ML. Polling + OS signals only.
- **Sideloaded Android, self-hosted server.** Play Store and public endpoints are constraints to avoid.
