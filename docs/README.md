# Scrollantir docs

Personal "palantir for yourself" time-tracking. Structured events across Mac + Android, owned end-to-end, Postgres as source of truth, custom dashboard.

Read in this order:

| Doc | What |
|---|---|
| [architecture.md](architecture.md) | System diagram, event schema, source naming, collection pattern, pipeline. Start here. |
| [android.md](android.md) | Implementation reference for the phone app. What's built, how it works, toolchain versions, known tradeoffs. |
| [mac.md](mac.md) | **Spec to be implemented.** ActivityWatch + forked `aw-watcher-web` (for Zen container tracking) + Python launchd forwarder. |
| [setup.md](setup.md) | Runbook: stub-server start, Android install dance (Android 15 spoof), permission grants. |

## Not yet written

- `server.md` — FastAPI ingest spec for the production server (Cloud Run / VM + Neon Postgres), auth, rate limits, deployment
- `dashboard.md` — Next.js + Tremor dashboard, query templates, view designs
- `queries.md` — reusable SQL snippets for core cross-source joins (mac-vs-phone, workspace breakdown, content-mode ratios)

## Principles

- **Own the data.** No SaaS. Events land in own Postgres.
- **Local-first collection.** Every device has a durable queue. Forwarders are the only thing touching the network.
- **One shape for all events.** `{id, device, source, timestamp, duration_s, data}`. Simpler queries, simpler ingest.
- **Source = stable raw fact, tags = ontology.** Events never re-interpreted. "Short form" is a tag joined at query time, not a source name.
- **Pattern B collection.** Track state in memory, emit completed event on change. No heartbeats on the wire.
- **Lightweight.** No screen recording, no OCR, no always-on ML. Polling + OS signals only.
- **Sideloaded Android, self-hosted server.** Play Store and public endpoints are constraints to avoid.
