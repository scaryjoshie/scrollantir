# Scrollantir — Supabase backend

The durable store and write-path for the whole system. Phone and Mac
forwarders write events here; future dashboard and local agent read
from here.

This doc is the **reference** for how the Supabase side is organized
and why. It's written to be picked up cold by a future agent or
future-you, so it leans explicit over narrative.

## What's here vs where it lives on disk

| Topic | Files |
|---|---|
| Declarative schema | `supabase/schemas/public.sql`, `supabase/schemas/private.sql` |
| Generated migration | `supabase/migrations/<ts>_init_scrollantir.sql` (regenerate, don't hand-edit) |
| Seed (tag ontology) | `supabase/seed.sql` |
| Ingest edge function | `supabase/functions/ingest/index.ts` |
| Admin CLI (devices + tokens) | `scripts/admin.py` (local only; never deployed) |
| Project ref + config | `supabase/config.toml` |

Project ref: `feijpewzqgqczkxmvdng`. Edge function URL pattern:
`https://feijpewzqgqczkxmvdng.supabase.co/functions/v1/ingest`.

## The data contract (one shape for every event)

Every writer — Mac forwarder, Android app, phone UI answering a
prompt, scheduled job — produces this exact shape. Every reader joins
on `(device, source)` to get metadata.

```
events:
  id              UUID PRIMARY KEY          -- client-generated. Mac uses uuid5 for determinism; Android uuid4.
  device          TEXT REFERENCES devices   -- 'mac' | 'phone' | ...
  source          TEXT                      -- 'system.window' | 'youtube.shorts' | 'prompt.sleep_latency'
  timestamp_utc   TIMESTAMPTZ
  duration_s      DOUBLE PRECISION          -- 0 for point events
  data            JSONB                     -- source-specific payload, stable per source
  schema_version  SMALLINT DEFAULT 1        -- bump if a source's data shape evolves
  received_at     TIMESTAMPTZ DEFAULT NOW()
  is_backfill     BOOLEAN DEFAULT FALSE     -- true if timestamp was >1 day old when ingested
```

Deduplication is by `id` (`ON CONFLICT DO NOTHING`). Retries produce
the same UUID, so the server never double-inserts.

## Components and their responsibilities

```
 ┌──────────────────────────┐                  ┌──────────────────────────────┐
 │ Mac forwarder (launchd)  │                  │ Supabase                     │
 │   aw-client → POST       │───── token ─────>│                              │
 │                          │                  │ edge function (ingest_role)  │
 │ Android app              │                  │   calls                      │
 │   POST                   │───── token ─────>│     ingest_api.accept_event  │
 └──────────────────────────┘                  │       ↓ insert               │
                                               │     events                   │
 ┌──────────────────────────┐                  │                              │
 │ Admin CLI (local)        │                  │ devices  source_tags         │
 │   scripts/admin.py       │                  │ private.tokens               │
 │   service_role           │───────────────── │ private.ingest_rate_limit    │
 └──────────────────────────┘                  │                              │
                                               │                              │
 ┌──────────────────────────┐                  │ reports, insights, prompts,  │
 │ Local Claude Code agent  │                  │ annotations (derived)        │
 │   (future)               │                  │                              │
 │   SELECT from ground     │───── agent ─────>│ agent_api.upsert_*           │
 │   truth, write via RPC   │                  │ agent_api.soft_delete_*      │
 └──────────────────────────┘                  │                              │
                                               │                              │
 ┌──────────────────────────┐                  │ (eventually) RLS policies    │
 │ Dashboard (future)       │  Supabase Auth   │ for authenticated role       │
 │   web, reads only        │───────────────── │                              │
 └──────────────────────────┘                  └──────────────────────────────┘
```

## Trust boundaries (roles, strictly scoped)

No role has more power than it needs. Compromise of one role has a
bounded blast radius.

| Role | Used by | Read scope | Write scope |
|---|---|---|---|
| `service_role` | Admin CLI only | everything | everything |
| `ingest_role` | Ingest edge function only | nothing directly | only via `ingest_api.accept_event` |
| `agent_role` | Local Claude Code only | `public.*` SELECT (ground truth + derived) | only via `agent_api.*` singletons |
| `authenticated` | Dashboard (you, via Supabase Auth) | per RLS policies (defined when dashboard lands) | nothing |
| `anon` | nothing we control | nothing | nothing |

`agent_role` has `statement_timeout = '5s'` to kill runaway queries.
It has no access to `private.*` at all.

## Schemas and tables

### `public/` (ground-truth and agent-writeable)

- **`events`** — append-only fact stream. See "data contract" above.
- **`devices`** — device registry. `(device_id TEXT PK, label, platform, note, created_at, retired_at)`. FK target for `events.device` and `tokens.device_id`.
- **`source_tags`** — cross-cutting labels. `(device, source, tag, created_at)` composite PK. Seeded with `short_form`, `social_feed`, `activity_signal`. Free-text `tag`; new tags added via `INSERT`.
- **`reports`** — agent-generated summaries. `(id, title, body, origin, created_at, updated_at, deleted_at)`.
- **`insights`** — small structured findings. Same lifecycle columns as `reports`.
- **`annotations`** — human or agent notes on time ranges or individual events.
- **`prompts`** — agent-initiated questions. `(id, created_at, asked_by, question, context JSONB, answer_schema JSONB, expires_at, answered_at, dismissed_at)`. When answered, the *answer* is emitted as an event with `source='prompt.<kind>'`; the prompt row tracks lifecycle only.
- **`events_enriched`** (view) — events JOINed with devices (label, platform) and source_tags (as array). LLM-friendly query surface.

### `private/` (never exposed via PostgREST; schema not in `api.schemas` list)

- **`tokens`** — device credentials. `(token_hash TEXT PK, token_prefix, device_id FK, note, created_at, last_used_at, superseded_at, revoked_at)`. sha256 of plaintext only; plaintext never stored.
- **`ingest_rate_limit`** — per-minute counters. `(token_hash, window_start, hits)` PK is composite.

### `ingest_api/` (the only write path for incoming events)

- **`accept_event(token, device, source, timestamp_utc, duration_s, data, schema_version) → uuid`** — `SECURITY DEFINER`. Does:
  1. `sha256(token)`, look up `private.tokens`; reject if missing/revoked
  2. Rate limit via `private.ingest_rate_limit` at 200/min/token; reject on overage
  3. Reject if `timestamp_utc > now() + 5min` or `< now() - 30 days`
  4. Flag `is_backfill = (timestamp_utc < now() - 1 day)`
  5. Reject if `device != tokens.device_id` (cross-device spoofing guard)
  6. For `source = 'phone.location'`, bucket lat/lng to 4 decimals (~11m) before insert
  7. `INSERT INTO events ... ON CONFLICT (id) DO NOTHING`; return id

### `agent_api/` (singleton write paths for derived tables)

Every function operates on **one row at a time**. Mass mutation is
structurally impossible from `agent_role`.

- **`upsert_report(id uuid, title text, body text) → uuid`** — create or update; if `id` provided, must be agent-origin and not deleted.
- **`upsert_insight(id, ...)`** — same pattern.
- **`upsert_annotation(id, ...)`** — same.
- **`create_prompt(kind text, question text, context jsonb, expires_at timestamptz) → uuid`** — agent-initiated questions.
- **`soft_delete_report(id)` / `soft_delete_insight(id)` / `soft_delete_annotation(id)`** — sets `deleted_at` on one row. Hard deletion requires admin CLI.

Hard-delete intentionally unavailable to agents.

## Lifecycle flows

### Event ingest (Mac forwarder or Android app)

1. Client builds payload matching the contract.
2. POSTs to `.../functions/v1/ingest` with `Authorization: Bearer <token>`.
3. Edge function (as `ingest_role`) calls `ingest_api.accept_event(...)`.
4. Function hashes token, rate-limits, validates timestamp, inserts.
5. Returns `{ok: true, count: 1}` or appropriate 4xx.

On network error / 5xx / rate-limit error, the client does not advance
its checkpoint; next run retries. UUIDs are deterministic (on Mac) or
locally generated (on Android), and `ON CONFLICT DO NOTHING` dedupes
server-side.

### Device onboarding

```
./admin device add mac --label "MacBook Pro" --platform macos
./admin mint --device-id mac --show-token          # prints QR + plaintext
# On Mac: setup.sh prompts for URL + token; stores in Keychain.
# On phone: QR scan auto-fills URL + token + device_id into SecurePrefs.
```

### Token rotation

```
./admin rotate --device-id mac                     # old: superseded_at = NOW(), still valid
                                                   # new: minted, prints QR/plaintext
# Update device config to use new token.
./admin list                                        # watch for new token's last_used_at to update
./admin rotate --device-id mac --finalize          # revokes all superseded tokens for this device
```

### Agent generates a report

```
-- Running as agent_role, via local Claude Code:
SELECT * FROM events_enriched
WHERE device_platform = 'android'
  AND 'short_form' = ANY(tags)
  AND timestamp_utc > NOW() - INTERVAL '7 days';

-- ... reason over results ...

SELECT agent_api.upsert_report(NULL, 'weekly-2026-04-20', '<markdown body>');
```

### Agent asks user a question

```
-- Agent side (local):
SELECT agent_api.create_prompt('sleep_latency',
                               'How long did you take to fall asleep last night?',
                               '{"trigger": "nightly"}'::jsonb, NOW() + INTERVAL '2 days');

-- Phone: subscribed via Supabase Realtime to public.prompts; notification fires.
-- User types answer in phone UI; phone POSTs to edge function with:
--   { prompt_id, answer }
-- Edge function: UPDATE prompts SET answered_at = NOW()
--                INSERT INTO events (source='prompt.sleep_latency', data={"value": 23, ...})

-- Agent next run sees that event like any other.
```

## Design commitments (don't re-litigate these)

- **One shape for all events, including prompt answers.** No `prompt_responses` table. Prompts track lifecycle; answers are events.
- **Sources are free text.** New collectors emit unknown sources without a pre-registration step.
- **Devices FK is enforced on events.** `events.device → devices.device_id`. Ingest can't land an event from an unknown device because minting a token requires an existing device_id.
- **Device identity is split from label.** `device_id` is the immutable stable key (carried on events); `label` is the human-readable name (renameable freely, zero auth impact).
- **Tokens are hashed at rest.** `sha256(plaintext)`. Plaintext shown exactly once during mint.
- **Rotation has a bounded end state.** `rotate` marks old tokens superseded; `rotate --finalize` revokes them. Not time-based auto-expiry.
- **Writes come only from RPCs.** Both ingest (via `ingest_role`) and derived-table writes (via `agent_role`) go through `SECURITY DEFINER` functions. No raw INSERT/UPDATE/DELETE from those roles.
- **Location precision reduced at write time**, not read. 4 decimals (~11m) inside `accept_event` for `phone.location`. Raw precision never hits storage.
- **RLS is enabled everywhere**, default-deny. Policies land with the dashboard.
- **Declarative schema.** Edit `supabase/schemas/*.sql`, regenerate migrations. Hand-written migrations only for RLS policies (which the declarative tool doesn't track) and other imperative needs.

## Security posture

| Scenario | Outcome |
|---|---|
| Random internet bot hits `/rest/v1/events` | `[]` — RLS default-deny, no policies |
| Random bot hits `/rest/v1/tokens` | 404 — `tokens` is in `private` schema, not in `api.schemas` |
| Random bot hits `/functions/v1/ingest` | 401 — missing or invalid bearer |
| Attacker extracts ingest edge function credentials | Can call only `ingest_api.accept_event`. Cannot SELECT anything, cannot touch tokens or derived tables. |
| Attacker extracts device bearer (e.g., phone compromise) | Can POST events as that device. Cannot read anything. Revocable via `admin revoke`. |
| Attacker extracts local agent credentials | Can SELECT ground truth + derived. Can call `agent_api.*` singletons one row at a time. Cannot DELETE or mass-UPDATE. Cannot touch `private.*`. |
| Database dump leaks | Token bearers are hashed; hashes are useless. Precision-reduced coordinates limit location leakage. |

## What's explicitly out of scope

- Multi-user anything. One user (the owner).
- Dashboard code. Separate project.
- iOS collector. Architecture-level out of scope.
- Historical data migration. None to migrate.
- Per-event ACLs beyond table-level RLS. Too much ceremony for single-user.

## Checklist for future agents picking this up

1. Read this doc and `architecture.md`.
2. Run `supabase db diff --linked --schema public,private` — if it reports changes, the declarative schema has drifted from remote.
3. Check `private.tokens` via `supabase db reset` locally or `psql` — never via PostgREST.
4. When adding a new writer (collector, UI), route through `ingest_api.accept_event`, not raw INSERT.
5. When adding a new derived table, add singleton `agent_api.upsert_X` / `soft_delete_X` functions for it. Do not GRANT INSERT/UPDATE/DELETE directly to `agent_role`.
6. When adding a new source, consider whether to seed `source_tags` entries for it (not required, but often desired for dashboard queries).
