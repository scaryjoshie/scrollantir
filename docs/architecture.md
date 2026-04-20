# Scrollantir — Architecture

Personal time-tracking system. "Palantir for myself" — structured stats on computer + phone usage, lightweight, owned end-to-end.

## Goals

- Know where time actually goes across Mac and Android
- Distinguish *which* browser tab / workspace / YouTube mode, not just "Chrome" or "YouTube"
- Resolve ambiguity between "on Mac" and "on phone with Mac open in front of me"
- Own the data. Custom dashboard over own Postgres. No SaaS lock-in.

## Non-goals

- Screen recording / OCR (Screenpipe-style). Too heavy, too invasive.
- iOS tracking. Apple's sandboxing makes it infeasible at the granularity we want.
- Multi-user. This is a personal system, architected for one.
- Real-time dashboards. Store-and-forward with ~30s–15min latency is fine.
- Active in-app metadata extraction in v1 (video titles, channels). Defer to a later enrichment job.

## System diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                          MAC                                    │
│                                                                 │
│  ActivityWatch (menu bar)                                       │
│  ├─ aw-watcher-window      ── frontmost app + title             │
│  ├─ aw-watcher-afk         ── keyboard/mouse idle state         │
│  └─ aw-watcher-web (fork)  ── Zen tabs + container              │
│                                                                 │
│  All write to AW's local SQLite (~/Library/Application Support) │
│                                                                 │
│  Mac forwarder (launchd agent, Python)                          │
│  ├─ polls AW SQLite for new events                              │
│  ├─ remaps to scrollantir source names + device                 │
│  ├─ batches, POSTs to server                                    │
│  └─ tracks "last forwarded" rowid checkpoint per AW bucket      │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │  HTTPS + bearer token
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      INGEST SERVER                              │
│                                                                 │
│  FastAPI container                                              │
│  ├─ POST /ingest (bearer auth, rate limit, Pydantic validation) │
│  └─ INSERT ... ON CONFLICT (id) DO NOTHING (idempotent)         │
│                                                                 │
│  Postgres                                                       │
│  ├─ events  (raw, append-only, never re-interpreted)            │
│  └─ source_tags (ontology, joined at query time)                │
└──────────────────────────────▲──────────────────────────────────┘
                               │
                               │  HTTPS + bearer token
                               │
┌─────────────────────────────────────────────────────────────────┐
│                        ANDROID                                  │
│                                                                 │
│  Custom app (sideloaded, no Play Store)                         │
│  ├─ Foreground service (persistent notification, keep alive)    │
│  ├─ UsageStats poller    ── phone.system.foreground             │
│  ├─ BroadcastReceiver    ── phone.system.screen / .unlocked     │
│  ├─ AccessibilityService ── phone.youtube.shorts, etc.          │
│  │    (detectors derived from DigiPaws, GPLv3)                  │
│  └─ Room DB (local queue, UUIDs, durable across reboots)        │
│                                                                 │
│  WorkManager forwarder (PeriodicWorkRequest, 15min+)            │
│  ├─ NetworkType.CONNECTED constraint                            │
│  ├─ POST batch to server                                        │
│  └─ DELETE acknowledged rows from local queue                   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
                       (Dashboard — TBD)
                        Next.js + Tremor
                      reading Postgres directly
```

## Data model

Every event — every source, both platforms — has the same shape.

```json
{
  "id": "uuid-v4, generated on client",
  "device": "phone",
  "source": "youtube.shorts",
  "timestamp": "2026-04-19T14:23:01Z",
  "duration_s": 47.2,
  "data": {}
}
```

Fields:

- `id` — UUID v4 generated on the client. Server uses this for `ON CONFLICT (id) DO NOTHING` idempotency.
- `device` — which physical device emitted this. `phone`, `mac`, future: `work-laptop`, etc. Top-level filter, indexed.
- `source` — dot-namespaced path within a device. `{namespace}.{specifier}`. Examples: `system.foreground`, `system.screen`, `youtube.shorts`, `instagram.reels`, `zen.tab`.
- `timestamp` — UTC, ISO-8601 with explicit `Z`. Start of the event's window.
- `duration_s` — seconds, float. `0` for point events.
- `data` — JSON. Carries facts the source string doesn't already imply. May be `{}`.

The `(device, source)` pair identifies a stream. Within one stream, `data` schema is stable.

### Source naming

Three-level hierarchy: `{device}.{namespace}.{specifier}`.

- **device** is its own column, but conceptually the leftmost level.
- **namespace** = `system` for OS-level watchers; app name (lowercased, no domain) for in-app detectors.
- **specifier** = the specific stream within that namespace.

Examples:

| device | source                  | What |
|--------|-------------------------|------|
| phone  | `system.foreground`     | OS-level frontmost app, per session |
| phone  | `system.screen`         | Raw screen-on/off spans (incl. lock peeks) |
| phone  | `system.unlocked`       | User-present-through-screen-off spans |
| phone  | `system.unlock`         | Unlock count (point event) |
| phone  | `youtube.shorts`        | YouTube in Shorts view |
| phone  | `youtube.video`         | YouTube in regular video view |
| phone  | `instagram.reels`       | Instagram in Reels view |
| phone  | `instagram.feed`        | Instagram in main feed |
| phone  | `instagram.stories`     | Instagram in Stories view |
| phone  | `tiktok.feed`           | TikTok (whole app is feed) |
| phone  | `detector.miss`         | Diagnostic: foreground was a target app but no rule matched |
| mac    | `system.window`         | Frontmost app + window title |
| mac    | `system.afk`            | Active vs. idle (3min keyboard/mouse threshold) |
| mac    | `zen.tab`               | Zen tab URL/title/container |

Adding a new in-app detector later (e.g., Reddit scroll vs. read) just means new sources like `phone.reddit.scroll`, `phone.reddit.post`. No schema migration.

### Source vs. data vs. tags — what belongs where

- **source**: a *stable identifier* for the stream. Names a fact at the lowest level that's stable across app versions. (`youtube.shorts` is stable; the underlying resource ID `reel_recycler` is not.)
- **data**: facts specific to *this row* that aren't already in the source name. Tab URL, foregrounded package name, screen state. Schema is fixed per source.
- **tags** (separate table): cross-cutting categorizations that may change over time. "Short form" is a tag, not a source. "Productive" is a tag. "Distracting" is a tag.

> **The events table stores what we observed. The tags table stores what we think it means. They're decoupled so you can change your mind about meaning without rewriting history.**

### Source tags

```sql
CREATE TABLE source_tags (
  device TEXT NOT NULL,
  source TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (device, source, tag)
);

INSERT INTO source_tags (device, source, tag) VALUES
  ('phone', 'youtube.shorts',   'short_form'),
  ('phone', 'instagram.reels',  'short_form'),
  ('phone', 'tiktok.feed',      'short_form'),
  ('phone', 'youtube.shorts',   'video'),
  ('phone', 'youtube.video',    'video'),
  ('phone', 'instagram.feed',   'social_feed'),
  ('phone', 'instagram.reels',  'social_feed'),
  ('phone', 'instagram.stories','social_feed');
-- and so on
```

Seed file lives in the repo (`server/seeds/source_tags.sql`), applied on deploy. Tags are version-controlled alongside the watchers that emit them.

Query "short-form video time this week":

```sql
SELECT SUM(e.duration_s)
FROM events e
JOIN source_tags t USING (device, source)
WHERE t.tag = 'short_form'
  AND e.timestamp_utc > NOW() - INTERVAL '7 days';
```

A source can carry multiple tags. Tagging is one-to-many, applied at query time, never written into events.

### Duration vs point events

Both use the same schema. Point events have `duration_s: 0`. Same table, same ingest path, same ID scheme.

- **Duration**: something was true for a span. `system.foreground`, `system.screen`, `system.window`.
- **Point**: something happened at an instant. `system.unlock`.

Duration tells you how time was spent. Point tells you behavior patterns (context-switching frequency, unlock count). Both valuable; collect point events opportunistically where the OS already tells us.

### Timestamp discipline

- **Always UTC on the wire.** `Instant.now().toString()` (Kotlin), `datetime.now(timezone.utc).isoformat()` (Python). Never local time, never naive.
- **Store as `TIMESTAMPTZ`** in Postgres.
- **Render in local time at the dashboard layer.** Travel + DST shouldn't corrupt stored data.

## Collection pattern (Pattern B)

> Track state in memory. Emit a completed event when the state changes.

Not heartbeats. Not start/stop signals. The watcher holds "currently X since T" in process memory, and when X changes to Y:

1. Emit `{source, start: T, duration: now - T, data: X}` into the local queue.
2. Set current = Y, T = now.

Works because:

- Foreground service signals (ACTIVITY_RESUMED/PAUSED, SCREEN_ON/OFF) give clean transition events.
- The forwarder's durable queue provides crash resilience at a different layer.
- No merging logic anywhere. Simpler than heartbeats.

Crash handling: on service startup, in-memory state is gone. We lose at most one in-flight session per crash. Acceptable trade for the simplicity.

Liveness heartbeat (different thing): write a "service alive at T" timestamp to local storage every minute. On startup, if we want to know how stale our last data was, this gives a floor.

## Store-and-forward

Every device has a durable local SQLite queue. Watchers write to it. A forwarder drains it.

### Local queue schema (both platforms identical)

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,           -- UUID v4
  device TEXT NOT NULL,
  source TEXT NOT NULL,
  timestamp_utc TEXT NOT NULL,   -- ISO-8601 with Z
  duration_s REAL NOT NULL,
  data_json TEXT NOT NULL        -- serialized JSON, "{}" if empty
);
```

### Forwarder loop

1. `SELECT * FROM events ORDER BY timestamp_utc LIMIT 500`
2. POST batch to `https://<server>/ingest` with `Authorization: Bearer <token>`
3. On `200`: `DELETE FROM events WHERE id IN (:ids)`
4. On anything else: do nothing. WorkManager / launchd retries.

No checkpoint. No `sent` flag. Queue contents == unsent events.

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

CREATE INDEX events_device_source_time
  ON events (device, source, timestamp_utc);

INSERT INTO events (...) VALUES (...)
ON CONFLICT (id) DO NOTHING;
```

A retry after a lost 200 response is a no-op. No duplicates ever.

### Mac is special

Mac doesn't own a local queue we control — ActivityWatch owns its SQLite. So the Mac forwarder reads from AW with a per-bucket rowid checkpoint instead of delete-on-ack. To keep idempotency, the Mac forwarder synthesizes deterministic UUIDs via `uuid5(NAMESPACE_URL, f"{aw_bucket_id}:{aw_row_id}")` so a re-read of the same AW row produces the same UUID and the server dedupes.

## Sources (full v1 list)

### Phone (Android)

| Source | What | How |
|---|---|---|
| `system.foreground` | Per-app foreground sessions | UsageStatsManager poller |
| `system.screen` | Raw screen-on sessions (incl. lock-screen peeks) | ACTION_SCREEN_ON/OFF |
| `system.unlocked` | Actually-using-phone sessions | USER_PRESENT → SCREEN_OFF |
| `system.unlock` *(point)* | Unlock count | USER_PRESENT |
| `youtube.shorts` | YouTube in Shorts view | AccessibilityService |
| `youtube.video` | YouTube in regular video view | AccessibilityService |
| `instagram.reels` | Instagram in Reels view | AccessibilityService |
| `instagram.feed` | Instagram in feed view | AccessibilityService |
| `instagram.stories` | Instagram in Stories | AccessibilityService |
| `tiktok.feed` | TikTok (whole app is feed) | AccessibilityService |
| `detector.miss` *(point)* | Target app foregrounded but no rule matched | AccessibilityService |

### Mac

| Source | What | How |
|---|---|---|
| `system.window` | Frontmost app + window title | aw-watcher-window |
| `system.afk` | Active vs. idle (3min threshold) | aw-watcher-afk |
| `zen.tab` | Zen tab URL/title/container | Forked aw-watcher-web |

Mac-vs-phone disambiguation query:

```
active_mac   = (mac.system.afk status=active) ∩ (mac.system.window exists)
active_phone = phone.system.unlocked

both        = active_mac ∩ active_phone        -- doomscrolling next to laptop
mac_only    = active_mac - active_phone        -- actually working
phone_only  = active_phone - active_mac        -- actually on phone
```

`system.unlocked` (not `system.screen`) is the correct signal — glancing at the lock screen shouldn't count as phone use.

## Server

Deferred. Rough plan:

- FastAPI in a Docker container
- Cloud Run or cheap VM with Docker Compose
- Neon Postgres (free tier, ~years of events at our volume) or self-hosted Postgres on same VM
- HTTPS with bearer token auth + slowapi rate limit
- Strip query strings from URLs client-side before send (session tokens hide there)
- Optional: put behind Tailscale and drop the public endpoint

Bandwidth math: ~5k–10k events/day × ~400 bytes = ~1–5 MB/day, ~150 MB/month. Gzipped even less. Non-issue.

## Dashboard

Deferred. Leaning Next.js + Tremor on Vercel, reading Postgres via Drizzle. Written with LLM assistance since Josh isn't a JS programmer. Fallback: Streamlit if JS proves painful.

Queries are a single template: events whose `[timestamp, timestamp + duration]` window intersects a period of interest, grouped by a field in `data` or by a tag joined from `source_tags`. Postgres `tstzrange` + `&&` operator.

## Open questions

- Signing Firefox extension for persistent install in Zen, vs. `xpinstall.signatures.required = false`.
- Whether 15-minute WorkManager forwarding cadence creates noticeable staleness in practice (probably fine).
- When DigiPaws detectors break after a YouTube redesign, how do we notice? — `detector.miss` events plus weekly dashboard review.
- v2: enrichment job — parses YouTube URLs from `mac.zen.tab` rows, calls YouTube Data API with own OAuth, populates a `content_items` table for video-level metadata.
