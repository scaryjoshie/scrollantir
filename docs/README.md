# Scrollantir docs

Personal "palantir for yourself" time-tracking. Structured events across Mac + Android, owned end-to-end, Postgres as source of truth, custom dashboard.

Read in this order:

| Doc | What |
|---|---|
| [architecture.md](architecture.md) | System diagram, event schema, source naming, collection pattern, pipeline. Start here. |
| [data-flow.md](data-flow.md) | End-to-end runtime placement: which plane runs where, which credential is used for each arrow, where the LLM lives (the orchestrator). Master mermaid diagrams. |
| [android.md](android.md) | Implementation reference for the phone app. What's built, how it works, toolchain versions, known tradeoffs. |
| [mac.md](mac.md) | Mac collector: ActivityWatch + forked `aw-watcher-web` (for Zen container tracking) + Python launchd forwarder. |
| [supabase.md](supabase.md) | The backend: schemas, roles, RPCs (`ingest_api`, `agent_api`), trust boundaries, lifecycle flows, security posture. |
| [admin-cli.md](admin-cli.md) | **Spec.** `scripts/admin.py` — device registry, role password setup, token mint/rotate/revoke, QR generation. |
| [edge-functions.md](edge-functions.md) | **Spec.** `supabase/functions/*` — ingest / prompt-answer / pending-prompts / scheduled (daily-digest, weekly-report, classifier, token-cleanup). |
| [agent.md](agent.md) | **Spec.** Agent conventions: CLAUDE.md shape, Postgres connection pattern, read/write API, examples. Predates the orchestrator decision — largely subsumed by `orchestrator.md`. |
| [orchestrator.md](orchestrator.md) | **Spec.** The reasoning plane: Claude Code CLI in a Docker container on Oracle Free + Coolify, cron-invoked. Four-phase setup, container contents, CLAUDE.md template, job prompts, secrets handling. |
| [projects.md](projects.md) | **Spec.** Projects + event classification layer. The "time on what" table plus a Groq/Cerebras-powered classifier. |
| [roadmap.md](roadmap.md) | Living plan: what's shipped, what's next, what's idea-only. Read here to know the current implementation state without replaying git history. |
| [setup.md](setup.md) | Runbook: Android install dance, Mac collector install, Supabase CLI install + link. |
| [location.md](location.md) | **Planned module.** Location tracking on Android — event schema, minimal-vs-full implementation, privacy considerations, Google Takeout alternative, prerequisites (real HTTPS, usage validation). |
| [places.md](places.md) | **Planned module.** Named-location layer on top of raw location events: schema, query-time matching, visit consolidation with bathroom-break tolerance, schedule-aware attendance derivation, chatbot-driven population. |
| [dashboard.md](dashboard.md) | **Planned module.** Mac Swift main portal: three stacked timelines (phone, mac, location), narrative-style location track, parsed/derived tables (`place_visits`, `travel_legs`), architectural options for deriving them. |
| [views.md](views.md) | **Planned module.** Agent-authored custom dashboards — architecture options (views-as-data vs views-as-TypeScript), starter template library, agent tool surface. |
| [cmux-watcher.md](cmux-watcher.md) | **Deferred.** Tab-level (surface) focus tracking inside the `manaflow-ai/cmux` terminal app. Design captured; shelved pending a downstream consumer since workspace-level is already free via `system.window` titles. |
| [session-2026-04-21.md](session-2026-04-21.md) | **Handoff chronicle** from the first end-to-end day. State snapshot, credentials posture, outstanding follow-ups from the Codex audit. Read this first if you're picking the project back up cold. |

## Not yet written

- `queries.md` — reusable SQL snippets for core cross-source joins (mac-vs-phone, workspace breakdown, content-mode ratios)

## Principles

- **Own the data.** No SaaS. Events land in own Postgres.
- **Local-first collection.** Every device has a durable queue. Forwarders are the only thing touching the network.
- **One shape for all events.** `{id, device, source, timestamp, duration_s, data}`. Simpler queries, simpler ingest.
- **Source = stable raw fact, tags = ontology.** Events never re-interpreted. "Short form" is a tag joined at query time, not a source name.
- **Pattern B collection.** Track state in memory, emit completed event on change. No heartbeats on the wire.
- **Lightweight.** No screen recording, no OCR, no always-on ML. Polling + OS signals only.
- **Sideloaded Android, self-hosted server.** Play Store and public endpoints are constraints to avoid.
