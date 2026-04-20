# Scrollantir docs

Personal "palantir for myself" time-tracking system. Structured stats across Mac + Android, local-first collection, store-and-forward to own Postgres, custom dashboard.

Start with [architecture.md](architecture.md) for the system overview and data model. Then the per-platform specs.

| Doc | What |
|---|---|
| [architecture.md](architecture.md) | System diagram, data model, store-and-forward pattern, full source list |
| [android.md](android.md) | Custom Android app spec — foreground service, UsageStats, screen/unlock, Shorts/Reels detector, Room queue, WorkManager forwarder. **Primary focus of v1.** |
| [mac.md](mac.md) | ActivityWatch setup + forked aw-watcher-web for Zen containers + Python launchd forwarder |

## Not yet written

- `server.md` — FastAPI ingest spec, deployment (Cloud Run vs. VM), Postgres schema, auth
- `dashboard.md` — dashboard stack, query templates, view designs
- `queries.md` — reusable SQL/AQL snippets for the core cross-source joins (mac-vs-phone, workspace breakdown, etc.)

## Principles

- **Own the data.** No SaaS. Events land in own Postgres.
- **Local-first collection.** Every device has a durable queue. Forwarder is the only thing that touches the network.
- **One shape for all events.** `{id, device, source, timestamp, duration_s, data}`. Simpler queries, simpler ingest.
- **Source = stable raw fact, tags = ontology.** Events table never re-interpreted. "Short form" is a tag joined at query time, not a source name.
- **Pattern B collection.** Track state in memory, emit a completed event on change. No heartbeats on the wire.
- **Lightweight.** No screen recording, no OCR, no always-on ML. Polling + OS signals only.
- **Sideload Android, self-host server.** Play Store and public endpoints are constraints to avoid.
