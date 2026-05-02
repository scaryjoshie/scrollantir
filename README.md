# Scrollantir

A personal "palantir for yourself" time-tracker. Structured activity events
from phone and Mac, owned end-to-end, with Postgres as the source of truth
and a derivation pipeline that turns raw events into a readable day timeline.

## Status

Single-user personal project. Not production-ready: no multi-user support,
no stability guarantees, no promises of backward-compatible schemas. Public
so others can borrow ideas, build their own version, or fork it.

## What it does

- **One timeline across devices.** Phone foreground app, Mac active window,
  browser tab + Firefox/Zen container, GPS-derived place visits, and travel
  legs — all on a shared clock.
- **Distinguishes *which* feed.** YouTube Shorts vs. video, Instagram Reels /
  Stories / feed, TikTok — not just "Instagram, 47 minutes."
- **Disambiguates Mac-vs-phone.** Cross-references Mac AFK + window state
  with phone screen-unlocked state, so "actually working on the laptop" is
  separable from "phone in hand next to the laptop."
- **Derives the structure, not just the rows.** Sleep windows, place visits,
  travel legs, and project chunks (LLM-classified) are computed by
  deterministic + LLM derivers running every few minutes over a rolling
  window.
- **All your data is yours.** Self-hosted Postgres on a small ARM VM. No
  third-party analytics SaaS in the loop.

## Stack

| Layer | What | Where |
|---|---|---|
| Phone collector | Kotlin + Jetpack Compose, [Room](https://developer.android.com/training/data-storage/room) for the local queue, [WorkManager](https://developer.android.com/topic/libraries/architecture/workmanager) for forwarding, an `AccessibilityService` for in-app feed detection, [Fused Location Provider](https://developers.google.com/location-context/fused-location-provider) + [Activity Recognition](https://developers.google.com/location-context/activity-recognition) for movement | `android/` |
| Mac collector | [ActivityWatch](https://activitywatch.net/) (window + AFK watchers as-is) plus a forked [`aw-watcher-web`](https://github.com/ActivityWatch/aw-watcher-web) that surfaces Firefox/Zen container info; Python forwarder run via `launchd` | `mac-extension/`, `mac-forwarder/` |
| Backend | [Caddy](https://caddyserver.com/) (TLS via Let's Encrypt) → [PostgREST](https://postgrest.org/) → [Postgres 17](https://www.postgresql.org/), plus a [FastAPI](https://fastapi.tiangolo.com/) service for the bits PostgREST can't do, all in one `docker compose` stack on a [Hetzner](https://www.hetzner.com/cloud/) ARM VM | `runtime/` |
| Derivation runtime | [APScheduler](https://apscheduler.readthedocs.io/) ticking deterministic Python derivers (sleep, place visits, travel legs, motion segments, window sessions) over rolling windows; project classification via [Cerebras](https://inference-docs.cerebras.ai/) / [Groq](https://console.groq.com/docs) | `runtime/app/src/scrollantir/` |
| Dashboard | Vite + React + TypeScript, [vis-timeline](https://github.com/visjs/vis-timeline) for swim lanes, [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/) for the location track, [TanStack Query](https://tanstack.com/query) over PostgREST, Tailwind | `dashboard/` |
| Admin | Local Python CLI for device + token + role lifecycle | `scripts/admin.py` (`./admin`) |

`supabase/` and `orchestrator/` are the previous data plane and the previous
Claude-Code-CLI-driven reasoning runtime. Both retired April 2026 in favor
of the self-hosted `runtime/` stack; left in-tree as history until the
migration is fully behind us.

## Design choices worth flagging

- **One event shape, all sources.** `{id, device, source, timestamp,
  duration_s, data}` — same column types whether the row came from the Mac
  forwarder, the Android tracker, or a derived span. Simpler queries,
  simpler ingest, one materializer to test.
- **Source = stable raw fact, tags = ontology.** "Short form" lives in a
  `source_tags` table joined at query time, not baked into a source name.
  Recategorize without rewriting events.
- **Pattern B collection.** Watchers hold "currently X since T" in memory
  and emit one completed event on transition. No heartbeats on the wire,
  fewer rows on disk.
- **Local-first, durable queue.** Both forwarders maintain a local queue
  with deterministic UUIDs (`uuid5` of `bucket:rowid` on Mac;
  client-generated v4 on phone), so retries after a lost response are a
  no-op `ON CONFLICT (id) DO NOTHING`.
- **No screen recording, no OCR, no on-device ML.** Event sources are OS
  signals plus a narrow `AccessibilityService` that walks for known
  resource IDs (heuristic adapted from
  [DigiPaws](https://github.com/nethical6/digipaws); see [CREDITS.md](CREDITS.md)).
- **GPS noise filter.** WiFi-triangulated fixes reported with optimistic
  accuracy were the source of "spazzing" tracks — a three-gate pipeline
  (accuracy threshold, GPS-attestation, inter-fix speed) drops them before
  they reach the queue.
- **Idempotent rolling-window derivation.** Each deriver tick re-emits its
  window's worth of derived rows via a `replace_derived_window` RPC, so
  re-runs converge instead of accumulating.
- **Narrative-style location track.** Phone and Mac activity are
  continuous → chart. Location is discrete → renders as a sentence
  (`●─home─● ╌walk╌ ●─class─●`), readable in one glance.

## Getting around

- [`docs/README.md`](docs/README.md) — index of every doc, read first.
- [`docs/architecture.md`](docs/architecture.md) — system diagram, event
  schema, source-naming rules.
- [`docs/data-flow.md`](docs/data-flow.md) — runtime placement, credential
  map, sequence diagrams.
- [`docs/setup.md`](docs/setup.md) — Android + Mac + backend runbook.
- [`CREDITS.md`](CREDITS.md) — upstream projects this depends on or
  borrows from.

## License

MIT, except for one file: `android/app/src/main/java/app/scrollantir/tracker/ContentDetectorService.kt`
is GPL-3.0-or-later because its detection heuristic is derived from
[DigiPaws](https://github.com/nethical6/digipaws). See [LICENSE](LICENSE)
and [CREDITS.md](CREDITS.md).
