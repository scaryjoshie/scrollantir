# Scrollantir docs

Personal "palantir for yourself" time-tracking. Structured events across Mac + Android, owned end-to-end, Postgres as source of truth, custom dashboard.

Read in this order:

| Doc | What |
|---|---|
| [architecture.md](architecture.md) | System diagram, event schema, source naming, collection pattern, pipeline. Start here. |
| [android.md](android.md) | Implementation reference for the phone app. What's built, how it works, toolchain versions, known tradeoffs. |
| [mac.md](mac.md) | Mac collector: ActivityWatch + forked `aw-watcher-web` (for Zen container tracking) + Python launchd forwarder. |
| [supabase.md](supabase.md) | The backend: schemas, roles, RPCs (`ingest_api`, `agent_api`), trust boundaries, lifecycle flows, security posture. |
| [setup.md](setup.md) | Runbook: Android install dance, Mac collector install, Supabase CLI install + link. |
| [location.md](location.md) | **Planned module.** Location tracking on Android — event schema, minimal-vs-full implementation, privacy considerations, Google Takeout alternative, prerequisites (real HTTPS, usage validation). |

## Not yet written

- `dashboard.md` — dashboard UI (Swift on Mac + possibly Next.js web), read paths via Supabase JS client + RLS
- `queries.md` — reusable SQL snippets for core cross-source joins (mac-vs-phone, workspace breakdown, content-mode ratios)
- `agent.md` — the local Claude Code agent: what it does, prompt scaffolding, convention for `reports` / `insights`

## Principles

- **Own the data.** No SaaS. Events land in own Postgres.
- **Local-first collection.** Every device has a durable queue. Forwarders are the only thing touching the network.
- **One shape for all events.** `{id, device, source, timestamp, duration_s, data}`. Simpler queries, simpler ingest.
- **Source = stable raw fact, tags = ontology.** Events never re-interpreted. "Short form" is a tag joined at query time, not a source name.
- **Pattern B collection.** Track state in memory, emit completed event on change. No heartbeats on the wire.
- **Lightweight.** No screen recording, no OCR, no always-on ML. Polling + OS signals only.
- **Sideloaded Android, self-hosted server.** Play Store and public endpoints are constraints to avoid.
