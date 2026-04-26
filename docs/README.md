# Scrollantir docs

Personal "palantir for yourself" time-tracking. Structured events across Mac + Android, owned end-to-end, Postgres as source of truth, custom dashboard.

Docs are organized by area. Cross-cutting concepts live at root; per-component implementation references are in subfolders.

## Start here

| Doc | What |
|---|---|
| [architecture.md](architecture.md) | System diagram, event schema, source naming, collection pattern, pipeline. **Start here.** |
| [data-flow.md](data-flow.md) | End-to-end runtime placement: which plane runs where, which credential is used for each arrow, where the LLM lives. Master mermaid diagrams. |
| [data-model.md](data-model.md) | **Foundation doc.** Event model (raw vs derived), primitives catalog, deriver class hierarchy (Deterministic / LLM), derivation registry, view catalog. The contract every component reads/writes to. Read alongside `architecture.md`. |
| [roadmap.md](roadmap.md) | Living plan: what's shipped, what's next, what's idea-only. Read here to know the current implementation state without replaying git history. |
| [setup.md](setup.md) | Runbook: Android install dance, Mac collector install, Supabase CLI install + link. |

## Per-component

### Collectors

| Doc | What |
|---|---|
| [android/](android/README.md) | Phone app implementation reference: tracker service, location/activity, QR onboarding, prompts inbox, build toolchain. |
| [mac/](mac/README.md) | Mac collection: ActivityWatch + forked `aw-watcher-web` (Zen container tracking) + Python launchd forwarder. |

### Backend (Supabase)

| Doc | What |
|---|---|
| [supabase/](supabase/README.md) | Schemas, roles, RPCs (`ingest_api`, `agent_api`), trust boundaries, lifecycle flows, security posture. |
| [supabase/edge-functions.md](supabase/edge-functions.md) | The three live edge functions (ingest / prompt-answer / pending-prompts) plus design notes for the jobs that moved to the orchestrator. |
| [supabase/admin-cli.md](supabase/admin-cli.md) | `scripts/admin.py` — device registry, role password setup, token mint/rotate/revoke, QR generation. |

### Reasoning runtime

| Doc | What |
|---|---|
| [runtime/](runtime/README.md) | The current POC orchestrator: Claude Code CLI in a Docker container on **Hetzner CAX11 + systemd** (Phases 0–2 shipped 2026-04-21; daily-digest + weekly-report cron-firing). |
| [runtime/rebuild-plan.md](runtime/rebuild-plan.md) | **Forward-looking.** The Python-based docker-compose stack that supersedes the POC: agent + Caddy + (future) Postgres slot. End state, derivers to ship, migration sequence. **Read this first if scaffolding `runtime/`.** |
| [runtime/agent.md](runtime/agent.md) | **Subsumed.** Local-Claude-Code conventions, agent_role + agent_api.* RPC reference. The orchestrator's CLAUDE.md derives from this contract. |
| [runtime/self-host.md](runtime/self-host.md) | Self-hosting the full stack — provisioning, credential management, monitoring. |

### Dashboard

| Doc | What |
|---|---|
| [dashboard/](dashboard/README.md) | Web-first rewrite (Vite + React + TS) at `dashboard/`. Three stacked timelines (phone, mac, location), narrative-style location track, derived tables (`place_visits`, `travel_legs`). |
| [dashboard/views.md](dashboard/views.md) | Agent-authored custom dashboards — architecture options, starter template library, agent tool surface. |

## Cross-cutting concepts

Multi-component features that span collection + derivation + render:

| Doc | What |
|---|---|
| [concepts/location.md](concepts/location.md) | Location tracking on Android — schema, Tier 1 vs Tier 2, privacy considerations, Google Takeout alternative. |
| [concepts/places.md](concepts/places.md) | Named-location layer: query-time matching, visit consolidation with bathroom-break tolerance, schedule-aware attendance derivation, chatbot-driven population. |
| [concepts/projects.md](concepts/projects.md) | Projects + event classification layer. The "time on what" table plus a Groq/Cerebras-powered classifier. |

## Deferred

| Doc | What |
|---|---|
| [deferred/cmux-watcher.md](deferred/cmux-watcher.md) | Tab-level focus tracking inside the `manaflow-ai/cmux` terminal app. Design captured; shelved pending a downstream consumer. |

## Sessions / chronicles

| Doc | What |
|---|---|
| [sessions/session-2026-04-21.md](sessions/session-2026-04-21.md) | First end-to-end day: state snapshot, credentials posture, outstanding follow-ups from the Codex audit. |
| [sessions/session-2026-04-23-aw-forwarder.md](sessions/session-2026-04-23-aw-forwarder.md) | Mac-forwarder truncation bug (93% data loss): diagnosis, fix spec, AFK-model decision (since reversed — see postscript). |
| [sessions/session-2026-04-25.md](sessions/session-2026-04-25.md) | Runtime-rebuild design + cleanup pass: location/places/workout deriver designs, AFK-gating decision, fresh-folder rationale, doc reorg. **Read this with rebuild-plan.md if picking up runtime work.** |
| [sessions/handoff-architecture-prompt.md](sessions/handoff-architecture-prompt.md) | Meta-artifact: subagent onboarding prompt for the data-model.md architecture-finalization conversation. |
| [sessions/handoff-runtime-onboarding.md](sessions/handoff-runtime-onboarding.md) | **Meta-artifact: copy-paste prompt to onboard a fresh agent for `runtime/` rebuild work.** Self-contained — points at reading list, open questions, don't-touch list, verification checks. |

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
