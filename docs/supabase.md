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
| Declarative schema | `supabase/schemas/10_public.sql` (devices, events, source_tags, derived, view, RLS policies), `20_private.sql` (tokens, rate_limit), `30_ingest_api.sql` (accept_event, accept_prompt_answer, pending_prompts), `40_agent_api.sql` (upsert_report/annotation, soft_delete_*, create_prompt), `50_grants.sql` (role grants) |
| Custom roles | `supabase/roles.sql` — ingest_role, user_role, agent_role (applied via `--include-roles`) |
| Generated migration | `supabase/migrations/<ts>_init_scrollantir.sql` (regenerate when schemas change; hand-append only for things the diff tool misses like `ALTER VIEW … SET (security_invoker = true)`) |
| Seed (tag ontology) | `supabase/seed.sql` |
| Ingest edge function | `supabase/functions/ingest/index.ts` (planned, not yet written) |
| Admin CLI (devices + tokens) | `scripts/admin.py` (planned, not yet written) |
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

### Event-ID contract (binding on all collectors)

The `id` is client-generated. The rule a collector must follow:

- **Mac forwarder** uses `uuid5(uuid.NAMESPACE_URL, f"{aw_bucket_id}:{aw_row_id}")`. Same input → same UUID. Retries after a lost response produce the same id, server dedupes. A post-crash replay of the exact same AW rows produces the same ids.

- **Android app** uses `uuid4` when the row is first inserted into the local Room DB. That UUID is then fixed for the life of the event — subsequent forwarder retries of the same Room row reuse the stored UUID. The app never regenerates.

- **Any future collector** must pick one of these patterns: deterministic-from-upstream-identity (preferred) or generate-once-store-locally. Never regenerate on retry.

- **Backfill after forwarder outage**: re-emit the same ids. `accept_event` dedupes via `ON CONFLICT`. Idempotent by construction.

- **Fixing a broken client-side bug that produced wrong ids**: the bad rows stay with their old ids; new rows get new ids; if you want to rewrite history, that's the admin CLI's job, not the collector's.

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
 ┌──────────────────────────────────────────┐  │ reports, annotations,        │
 │ Swift Mac app ("dashboard")              │  │ prompts, source_tags         │
 │                                          │  │                              │
 │  ┌─── user-initiated action ─────────┐   │  │  (view) events_enriched      │
 │  │ UI buttons: reclassify, curate,   │   │  │                              │
 │  │ bulk cleanup                      │   │  │                              │
 │  │ → user_role via Keychain cred     │───┼─>│  direct CRUD (user-side)     │
 │  └───────────────────────────────────┘   │  │                              │
 │                                          │  │                              │
 │  ┌─── spawned Claude Code agent ─────┐   │  │                              │
 │  │ reads + reasons about data        │   │  │                              │
 │  │ writes reports/annotations one at │   │  │                              │
 │  │ a time                            │   │  │                              │
 │  │ → agent_role via env var          │───┼─>│  agent_api.upsert_*          │
 │  └───────────────────────────────────┘   │  │  agent_api.soft_delete_*     │
 │                                          │  │                              │
 │  Two Keychain items:                     │  │                              │
 │    scrollantir/user-role                 │  │                              │
 │    scrollantir/agent-role                │  │                              │
 └──────────────────────────────────────────┘  └──────────────────────────────┘
```

## Trust boundaries (roles, strictly scoped)

No role has more power than it needs. Compromise of one role has a
bounded blast radius.

| Role | Used by | Read scope | Write scope |
|---|---|---|---|
| `service_role` | Admin CLI only | everything | everything |
| `ingest_role` | Ingest edge function only | nothing directly | only via `ingest_api.accept_event` |
| `user_role` | Swift Mac app, user-initiated actions | `public.*` SELECT | CRUD on derived tables (`reports`, `annotations`, `prompts`) and `source_tags`; SELECT-only on `events` and `devices` |
| `agent_role` | Claude Code subprocess (spawned by Swift app, or invoked directly in terminal) | `public.*` SELECT (ground truth + derived) | only via `agent_api.*` singletons |
| `anon` | nothing we control | nothing | nothing |

**Why `user_role` vs. `agent_role` are separate, even though you control
both.** The human at the keyboard can decide to retag 500 events or
purge last year's reports in one statement. The agent — which might be
prompt-injected — should never be able to do that. Keeping the two on
separate credentials means a rogue agent session can tombstone a
handful of rows via singleton calls, but cannot mass-corrupt derived
data or rewrite the tag ontology.

`agent_role` runs with `statement_timeout = '5s'` to kill runaway
queries. `user_role` gets `statement_timeout = '30s'` since it's
interactive. Neither role has any access to `private.*`.

## Grants (in detail)

```sql
-- Read grants (same for both non-admin roles)
GRANT USAGE ON SCHEMA public TO user_role, agent_role;
GRANT SELECT ON public.events, public.devices, public.events_enriched
  TO user_role, agent_role;
GRANT SELECT ON public.reports, public.annotations,
                public.prompts, public.source_tags
  TO user_role, agent_role;

-- User can CRUD derived + source_tags directly (including batch)
GRANT INSERT, UPDATE, DELETE ON public.reports,
                                 public.annotations, public.prompts,
                                 public.source_tags
  TO user_role;

-- Agent cannot write directly; routes through singleton functions
GRANT USAGE ON SCHEMA agent_api TO agent_role;
GRANT EXECUTE ON FUNCTION agent_api.upsert_report,
                          agent_api.upsert_annotation,
                          agent_api.create_prompt,
                          agent_api.soft_delete_report,
                          agent_api.soft_delete_annotation
  TO agent_role;

-- Neither touches private or events write path
REVOKE ALL ON SCHEMA private FROM user_role, agent_role;
REVOKE INSERT, UPDATE, DELETE ON public.events FROM user_role, agent_role;
REVOKE INSERT, UPDATE, DELETE ON public.devices FROM user_role, agent_role;

-- Per-role settings
ALTER ROLE user_role  SET statement_timeout = '30s';
ALTER ROLE agent_role SET statement_timeout = '5s';
```

## Schemas and tables

### `public/` (ground-truth and agent-writeable)

- **`events`** — append-only fact stream. See "data contract" above.
- **`devices`** — device registry. `(device_id TEXT PK, label, platform, note, created_at, retired_at)`. FK target for `events.device` and `tokens.device_id`.
- **`source_tags`** — cross-cutting labels. `(device, source, tag, created_at)` composite PK. Seeded with `short_form`, `social_feed`, `activity_signal`. Free-text `tag`; new tags added via `INSERT`.
- **`reports`** — agent-generated summaries. Any length — a one-paragraph "pattern finding" and a full weekly narrative both live here, distinguished by `tags`. `(id, title, body, origin, window_start, window_end, tags, created_at, updated_at, deleted_at)`.
- **`annotations`** — scoped notes attached to events, time ranges, days, sources, or devices. Polymorphic via `scope` + `scope_ref`. Agent corrections, user commentary, context additions.
- **`prompts`** — agent-initiated questions. `(id, created_at, asked_by, question, context JSONB, answer_schema JSONB, expires_at, answered_at, dismissed_at)`. When answered, the *answer* is emitted as an event with `source='prompt.<kind>'`; the prompt row tracks lifecycle only.
- **`events_enriched`** (view) — events JOINed with devices (label, platform) and source_tags (as array). LLM-friendly query surface.

### `private/` (never exposed via PostgREST; schema not in `api.schemas` list)

- **`tokens`** — device credentials. `(token_hash TEXT PK, token_prefix, device_id FK, note, created_at, last_used_at, superseded_at, revoked_at)`. sha256 of plaintext only; plaintext never stored.
- **`ingest_rate_limit`** — per-minute counters. `(token_hash, window_start, hits)` PK is composite.

### `ingest_api/` (the only write paths for incoming data)

- **`accept_event(token, id, device, source, timestamp_utc, duration_s, data, schema_version) → uuid`** — `SECURITY DEFINER`. Does:
  1. `sha256(token)`, look up `private.tokens`; reject if missing/revoked/expired-supersede
  2. Rate limit via `private.ingest_rate_limit` at 200/min/token; reject on overage
  3. Reject if `timestamp_utc > now() + 5min` or `< now() - 30 days`
  4. Flag `is_backfill = (timestamp_utc < now() - 1 day)`
  5. Reject if `device != tokens.device_id` (cross-device spoofing guard)
  6. For `source = 'phone.location'`, bucket lat/lng to 4 decimals (~11m) before insert
  7. `INSERT INTO events ... ON CONFLICT (id) DO NOTHING`; return id

- **`accept_prompt_answer(token, prompt_id, answer_event_id, data) → uuid`** — `SECURITY DEFINER`. The *only* way for the phone to answer a prompt. Does:
  1. Token validation as `accept_event`
  2. Look up `prompts.id = prompt_id`; reject if missing, already answered, dismissed, or expired
  3. Derive source from the prompt's `asked_by` kind (e.g., `prompt.sleep_latency`)
  4. `UPDATE prompts SET answered_at = NOW() WHERE id = prompt_id`
  5. `INSERT INTO events (id, device, source, timestamp_utc, duration_s, data, schema_version)` — the *answer* as an event
  6. Both steps happen in one transaction; failure of either rolls back
  7. Return the event.id

  This is its own named function (not shoehorned into `accept_event`) because the semantics differ: it mutates two tables, validates a foreign prompt, and derives the event's `source` from the prompt row rather than taking it from the client.

### `agent_api/` (singleton write paths for derived tables)

Every function operates on **one row at a time**. Mass mutation is
structurally impossible from `agent_role`.

- **`upsert_report(id uuid, title text, body text, tags text[], window_start timestamptz, window_end timestamptz) → uuid`** — create or update; if `id` provided, must be agent-origin and not deleted.
- **`upsert_annotation(id, scope, scope_ref, body)`** — same pattern, for scoped notes.
- **`create_prompt(kind text, question text, context jsonb, answer_schema jsonb, expires_at timestamptz, asked_by text) → uuid`** — agent-initiated questions.
- **`soft_delete_report(id)` / `soft_delete_annotation(id)`** — sets `deleted_at` on one row. Hard deletion requires admin CLI.

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
./admin rotate --device-id mac --finalize          # revokes all superseded tokens for this device (immediate)
```

Superseded tokens don't live forever. A `pg_cron` job runs hourly:

```sql
UPDATE private.tokens
SET    revoked_at = NOW()
WHERE  superseded_at IS NOT NULL
  AND  revoked_at IS NULL
  AND  superseded_at < NOW() - INTERVAL '48 hours';
```

So forgetting to `--finalize` doesn't leave stale credentials indefinitely; the grace window is bounded at 48h. Manual `--finalize` is the explicit shortcut when you've already verified the new token.

### Agent generates a report

The Swift Mac app spawns a Claude Code subprocess with
`SCROLLANTIR_DB_URL` in its env, pointing at the `agent_role`
connection string pulled from Keychain entry
`scrollantir/agent-role`.

```
-- Running as agent_role:
SELECT * FROM events_enriched
WHERE device_platform = 'android'
  AND 'short_form' = ANY(tags)
  AND timestamp_utc > NOW() - INTERVAL '7 days';

-- ... reason over results ...

SELECT agent_api.upsert_report(NULL, 'weekly-2026-04-20', '<markdown body>');
```

### User curates data from the dashboard UI

Swift app uses its own `user_role` credential (Keychain entry
`scrollantir/user-role`), not the agent's.

```
-- Running as user_role, from a Swift app UI action:
-- "bulk-retag all youtube.shorts on phone as distraction + short_form"
DELETE FROM source_tags
  WHERE device = 'phone' AND source = 'youtube.shorts';
INSERT INTO source_tags (device, source, tag) VALUES
  ('phone', 'youtube.shorts', 'short_form'),
  ('phone', 'youtube.shorts', 'distraction');

-- "archive all reports older than a year"
UPDATE reports SET deleted_at = NOW()
WHERE created_at < NOW() - INTERVAL '1 year' AND deleted_at IS NULL;
```

These operations are available to `user_role` but structurally
impossible under `agent_role`, by design.

### Agent asks user a question

```
-- Agent side (as agent_role):
SELECT agent_api.create_prompt(
  'sleep_latency',
  'How long did you take to fall asleep last night?',
  '{"trigger": "nightly"}'::jsonb,                            -- context
  '{"type": "number", "unit": "minutes"}'::jsonb,             -- answer_schema
  NOW() + INTERVAL '2 days',                                   -- expires_at
  'agent.nightly'                                              -- asked_by
);

-- Phone polls /functions/v1/pending-prompts every 30s (or on screen-on)
-- with its existing bearer. Returns any unanswered prompts. No Realtime
-- subscription; no Supabase Auth on the phone.

-- User answers in phone UI; phone POSTs to a second edge function endpoint:
--   POST /functions/v1/prompt-answer
--   Authorization: Bearer <phone-token>
--   Body: { prompt_id, answer_event_id: <uuid4>, data: {"value": 23, "unit": "minutes"} }

-- Edge function (as ingest_role) calls:
--   SELECT ingest_api.accept_prompt_answer(token, prompt_id, answer_event_id, data)
-- which atomically:
--   UPDATE prompts SET answered_at = NOW() WHERE id = prompt_id;
--   INSERT INTO events (id, source='prompt.sleep_latency', data=..., device='phone', ...);

-- Agent's next run sees that event like any other via events_enriched.
```

## Design commitments (don't re-litigate these)

- **One shape for all events, including prompt answers.** No `prompt_responses` table. Prompts track lifecycle; answers are events.
- **Sources are free text.** New collectors emit unknown sources without a pre-registration step.
- **Devices FK is enforced on events.** `events.device → devices.device_id`. Ingest can't land an event from an unknown device because minting a token requires an existing device_id.
- **Device identity is split from label.** `device_id` is the immutable stable key (carried on events); `label` is the human-readable name (renameable freely, zero auth impact).
- **Tokens are hashed at rest.** `sha256(plaintext)`. Plaintext shown exactly once during mint.
- **Rotation has a bounded end state.** `rotate` marks old tokens superseded; `rotate --finalize` revokes them. Not time-based auto-expiry.
- **Agent writes come only from RPCs.** `agent_role` cannot INSERT/UPDATE/DELETE directly on any table. All derived-table writes go through `agent_api.*` singleton SECURITY DEFINER functions.
- **User writes are direct SQL.** `user_role` has CRUD on derived tables + `source_tags` so batch curation from the dashboard UI is one statement, not one call per row. The trade-off is that a bug in the Swift UI's delete path could wipe all reports; you're the human, you're trusted to not YOLO.
- **Ingest writes come only from one RPC.** `ingest_role` can only call `ingest_api.accept_event` and `ingest_api.accept_prompt_answer`. Nothing else.
- **No Supabase Auth.** Dashboard and agent are local Mac processes; their credentials live in Mac Keychain. Add Supabase Auth only if a public web dashboard ever materializes.
- **Location precision reduced at write time**, not read. 4 decimals (~11m) inside `accept_event` for `phone.location`. Raw precision never hits storage.
- **RLS is enabled everywhere**, default-deny, with permissive `USING (true)` policies scoped to `user_role` and `agent_role`. The real auth layer is Postgres role grants; the policies exist only so RLS — which is required on all tables by Supabase best practice — doesn't drop everything on SELECT.
- **`events_enriched` view is SECURITY INVOKER**. Forces the view to run with the caller's privileges so RLS on underlying tables applies. The diff tool doesn't track view options, so we `ALTER VIEW` explicitly in each migration.
- **Declarative schema.** Edit `supabase/schemas/*.sql`, regenerate migrations. Hand-written migrations only for RLS policies (which the declarative tool doesn't track) and other imperative needs.
- **`source_tags` stays a lightweight many-to-many classifier.** If you need richer per-source metadata (display name, expected `data` fields, retention hints), add a `sources` table — don't stretch `source_tags` to carry it. The tag table is for orthogonal categories applied at query time, nothing more.
- **Strict `source` naming and `schema_version` discipline.** `events` stays a well-behaved table, not a junk drawer. When a source's `data` shape changes meaningfully, bump `schema_version`. When a new collector comes online, pick a stable name (`<namespace>.<specifier>`) that won't need to be renamed later.

## Security posture

| Scenario | Outcome |
|---|---|
| Random internet bot hits `/rest/v1/events` | `[]` — `anon` has no grants, RLS default-deny |
| Random bot hits `/rest/v1/tokens` | 404 — `tokens` is in `private` schema, not in `api.schemas` |
| Random bot hits `/functions/v1/ingest` | 401 — missing or invalid bearer |
| Attacker extracts ingest edge function credentials | Can call only `ingest_api.accept_event` / `accept_prompt_answer`. Cannot SELECT anything, cannot touch tokens or derived tables. |
| Attacker extracts device bearer (e.g., phone compromise) | Can POST events as that device. Cannot read anything. Revocable via `admin revoke`. |
| Attacker extracts `agent_role` credentials from Mac | Can SELECT ground truth + derived. Can call `agent_api.*` singletons one row at a time. Cannot DELETE, cannot mass-UPDATE, cannot modify `source_tags`. Cannot touch `private.*`. |
| Attacker extracts `user_role` credentials from Mac | Can SELECT everything in `public.*`. Can CRUD on derived and `source_tags` in bulk. Cannot modify events or devices, cannot touch `private.*`. Damage is bounded to derived data; events are still safe. |
| Attacker extracts `service_role` credentials from Mac | Full DB access — this is the worst case. Mitigation: `service_role` connection string lives only on your personal admin machine, never in the Swift app or agent. |
| Database dump leaks | Token bearers are hashed; hashes are useless. Precision-reduced coordinates limit location leakage. |

## What's explicitly out of scope

- Multi-user anything. One user (the owner).
- Dashboard code. Separate project.
- iOS collector. Architecture-level out of scope.
- Historical data migration. None to migrate.
- Per-event ACLs beyond table-level RLS. Too much ceremony for single-user.

## Checklist for future agents picking this up

1. Read this doc and `architecture.md`.
2. Figure out which role you're supposed to be: `service_role` (admin), `user_role` (UI-initiated from the Mac app), `agent_role` (you, if you're a spawned analysis agent). Don't use `service_role` for anything other than token/device lifecycle.
3. Run `supabase db diff --linked --schema public,private` — if it reports changes, the declarative schema has drifted from remote.
4. When adding a new collector, route through `ingest_api.accept_event`. Never `GRANT INSERT ON events` to anyone.
5. When adding a new derived table intended for agent writes, add singleton `agent_api.upsert_X` / `soft_delete_X` functions for it. Grant `user_role` direct CRUD + grant `agent_role` EXECUTE on the singletons.
6. When adding a new source, consider whether to seed `source_tags` entries for it (not required, but often desired for dashboard queries).
7. Never put Supabase Auth signup flows in the codebase without explicit approval — the project deliberately doesn't use it.
