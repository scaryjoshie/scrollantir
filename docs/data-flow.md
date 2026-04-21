# Scrollantir — Data flow and runtime placement

The end-to-end picture of what runs where, who talks to whom, and with
which credential. Written to be picked up cold: a future agent or
future-you should be able to read this one doc and know where every
piece of work lives. Deep-dive references live in the per-component
docs (`supabase.md`, `edge-functions.md`, `admin-cli.md`, etc.).

## TL;DR

Four planes of runtime, strictly separated:

1. **Devices** (phone, Mac) — collect events into a local durable queue
   and forward to Supabase. No LLM, no reasoning.
2. **Supabase edge functions** — the thin authenticated write path.
   Deno, stateless, co-located with Postgres. Handles ingest +
   prompt-answer + pending-prompts. No LLM calls.
3. **Postgres (Supabase)** — system of record. All business logic that
   must be atomic (token validation, rate limiting, prompt answer
   round-trip) lives in `ingest_api.*` and `agent_api.*` SQL functions.
4. **Orchestrator** (cheap always-on VPS or container) — the *only*
   place that runs an LLM-driven agent. Owns scheduled jobs
   (daily-digest, weekly-report, classifier, prompt-asker), serves
   interactive chat to the Mac dashboard, and keeps a local filesystem
   for skills + memory. Credentialed as `agent_role`; bounded blast
   radius.

Plus the **Admin CLI** (your local Mac only, `service_role`) for
device + token + role-password lifecycle. That's in its own plane
because it's the root-of-trust tool and never runs automated.

## Status

| Plane | State |
|---|---|
| Android collector | ✅ built, posting to stub server |
| Mac collector + forwarder | ✅ built, posting to stub server |
| Supabase schema v3 | ✅ deployed |
| Admin CLI | 🚧 just implemented, not yet run |
| Edge functions (ingest / prompt-answer / pending-prompts) | 📋 next |
| Orchestrator (server + agent runtime) | 💡 architecturally decided, deployment TBD |
| Swift Mac dashboard | 📋 later |

## System diagram

```mermaid
flowchart TB
  %% ═════════ Devices ═════════
  subgraph PHONE["📱 Phone (Android 14+)"]
    direction TB
    PhoneTracker["TrackerForegroundService<br/>→ Room DB local queue"]
    PhoneForwarder["ForwarderWorker<br/>(every 15 min)"]
    PhonePromptUI["Prompt inbox UI<br/>(polls + answers)"]
    PhoneTracker --> PhoneForwarder
  end

  subgraph MAC["💻 Mac (Josh's laptop)"]
    direction TB
    AW["ActivityWatch<br/>→ local SQLite"]
    MacForwarder["Mac Forwarder<br/>(launchd, every 15 min)"]
    SwiftDash["Swift Dashboard<br/>(planned)"]
    AdminCLI["Admin CLI<br/>scripts/admin.py"]
    Keychain[("Mac Keychain<br/>scrollantir/service-role*<br/>scrollantir/user-role<br/>scrollantir/agent-role<br/>scrollantir/ingest-role")]
    AW --> MacForwarder
    AdminCLI -- "writes" --> Keychain
    SwiftDash -- "reads" --> Keychain
  end

  %% ═════════ Supabase managed ═════════
  subgraph SUPABASE["☁️ Supabase (managed)"]
    direction TB
    subgraph EDGE["Edge Functions (Deno)"]
      IngestFn["POST /functions/v1/ingest"]
      PromptAnsFn["POST /functions/v1/prompt-answer"]
      PendingFn["GET /functions/v1/pending-prompts"]
    end
    subgraph PG["Postgres (private + public + *_api schemas)"]
      direction TB
      IngestAPI["ingest_api.accept_event<br/>ingest_api.accept_prompt_answer<br/>ingest_api.pending_prompts"]
      AgentAPI["agent_api.upsert_report<br/>agent_api.upsert_annotation<br/>agent_api.create_prompt<br/>agent_api.soft_delete_*"]
      PubTables[("public.events<br/>public.devices<br/>public.reports<br/>public.annotations<br/>public.prompts<br/>public.source_tags")]
      PrivTables[("private.tokens<br/>private.ingest_rate_limit")]
      EnrichView(["public.events_enriched (view)"])
      IngestAPI --> PubTables
      IngestAPI --> PrivTables
      AgentAPI --> PubTables
      EnrichView -.-> PubTables
    end
    EdgeSecrets[("Function secrets<br/>INGEST_DATABASE_URL")]
    IngestFn -- "as ingest_role" --> IngestAPI
    PromptAnsFn -- "as ingest_role" --> IngestAPI
    PendingFn -- "as ingest_role" --> IngestAPI
    EDGE -.reads.-> EdgeSecrets
    PgCron["pg_cron:<br/>token-cleanup hourly,<br/>superseded-token auto-revoke"] --> PrivTables
  end

  %% ═════════ Orchestrator ═════════
  subgraph ORCH["🧠 Orchestrator (cheap VPS, TBD)"]
    direction TB
    OrchScheduler["Internal scheduler<br/>daily-digest 7am<br/>weekly-report Sun 9am<br/>classifier every 15 min<br/>prompt-asker nightly"]
    OrchChatAPI["Chat HTTP/WS<br/>(Swift dashboard calls)"]
    OrchAgent["Agent runtime<br/>(Claude Code / Codex CLI<br/>+ tool inventory)"]
    OrchFS[("Local FS:<br/>skills/<br/>memory/<br/>state/")]
    OrchEnv[("Env secrets:<br/>AGENT_DATABASE_URL<br/>ANTHROPIC_API_KEY<br/>GROQ_API_KEY / CEREBRAS_API_KEY")]
    OrchScheduler --> OrchAgent
    OrchChatAPI --> OrchAgent
    OrchAgent -- "reads/writes" --> OrchFS
    OrchAgent -.reads.-> OrchEnv
  end

  %% ═════════ LLM providers ═════════
  subgraph LLMS["🤖 LLM providers (HTTPS API)"]
    Anthropic["Anthropic<br/>(Claude — main reasoning)"]
    Groq["Groq / Cerebras<br/>(fast+cheap — classifier)"]
  end

  %% ═════════ Arrows: device → Supabase ═════════
  PhoneForwarder -. "HTTPS POST events<br/>Bearer: phone token" .-> IngestFn
  PhonePromptUI -. "HTTPS GET pending<br/>Bearer: phone token" .-> PendingFn
  PhonePromptUI -. "HTTPS POST answer<br/>Bearer: phone token" .-> PromptAnsFn
  MacForwarder -. "HTTPS POST events<br/>Bearer: mac token" .-> IngestFn

  %% ═════════ Arrows: local Mac → Supabase ═════════
  AdminCLI == "service_role<br/>direct Postgres :5432" ==> PG
  SwiftDash -- "user_role<br/>direct Postgres :5432" --> PubTables

  %% ═════════ Arrows: Swift ↔ orchestrator ═════════
  SwiftDash -- "WSS chat" --> OrchChatAPI

  %% ═════════ Arrows: orchestrator → Supabase ═════════
  OrchAgent -- "agent_role SELECT<br/>direct Postgres :5432" --> EnrichView
  OrchAgent -- "agent_role SELECT" --> PubTables
  OrchAgent -- "agent_role EXECUTE<br/>singleton RPCs" --> AgentAPI

  %% ═════════ Arrows: orchestrator → LLMs ═════════
  OrchAgent -. "HTTPS" .-> Anthropic
  OrchAgent -. "HTTPS" .-> Groq
```

Legend:
- **Solid thick (`==>`)** = root-privileged, local-only (admin CLI → Postgres with `service_role`).
- **Solid thin (`-->`)** = direct Postgres TCP from a trusted workstation/server (Mac dashboard, orchestrator).
- **Dashed (`-.->`)** = HTTPS over the open internet with a bearer token.

## Actors, state, and creds

| Actor | Runs where | Holds | Credential | Can do |
|---|---|---|---|---|
| Android app | Pixel 9 | Local Room queue, device-bearer token in `EncryptedSharedPreferences` | Bearer token (issued per device) | POST ingest, GET pending prompts, POST prompt answers |
| Mac forwarder | launchd on your Mac | Per-bucket checkpoint in its local state file | Bearer token (keychain entry TBD) | POST ingest |
| Admin CLI | Your Mac, local venv | `service_role` DSN in `scripts/.env.admin` | `service_role` | Full Postgres access. Devices, tokens, `ALTER ROLE` |
| Swift dashboard | Your Mac | `scrollantir/user-role` Keychain item | `user_role` | SELECT `public.*`; CRUD on derived tables + `source_tags`; SELECT-only on `events`/`devices` |
| Orchestrator | Cheap VPS (TBD) | Local FS (skills/memory/state); env secrets | `agent_role` + LLM API keys | SELECT `public.*`; singleton writes via `agent_api.*`; call Anthropic/Groq APIs |
| Edge functions | Supabase Deno | No local state | `ingest_role` | Only `ingest_api.*` RPCs (accept_event, accept_prompt_answer, pending_prompts) |
| Postgres | Supabase | All ground truth | (runtime role varies) | Everything — scoped by the role the caller connected as |

## Flows (what each arrow means)

### A. Device → events ingest

```mermaid
sequenceDiagram
  autonumber
  participant D as Phone / Mac forwarder
  participant E as Edge fn /ingest
  participant P as Postgres
  D->>D: pull ≤500 unforwarded rows from local queue
  D->>E: POST /functions/v1/ingest<br/>Authorization: Bearer <device token><br/>Body: { events: [...] }
  E->>E: connect as ingest_role using INGEST_DATABASE_URL
  loop per event
    E->>P: SELECT ingest_api.accept_event(token, id, device, source, ts, dur, data, sv)
    P->>P: sha256(token) → private.tokens lookup
    P->>P: rate-limit check (private.ingest_rate_limit, 200/min)
    P->>P: timestamp + device validation
    P->>P: INSERT public.events ON CONFLICT (id) DO NOTHING
    P-->>E: event id (or raise)
  end
  E-->>D: 200 { ok: true, count: N } or 4xx
  D->>D: on 2xx: mark rows forwarded_at = now; on 5xx/429: backoff + retry
```

All ingest writes are idempotent by `events.id`. Retries after lost
responses are no-ops.

### B. Agent-initiated prompt round-trip

```mermaid
sequenceDiagram
  autonumber
  participant O as Orchestrator
  participant P as Postgres
  participant E as Edge fns
  participant Ph as Phone
  O->>P: SELECT agent_api.create_prompt(kind, question, ctx, schema, expires_at, asked_by)<br/>as agent_role
  P->>P: INSERT public.prompts
  Note over Ph: every 30 s or on screen-on
  Ph->>E: GET /functions/v1/pending-prompts<br/>Bearer: phone token
  E->>P: SELECT ingest_api.pending_prompts(token)
  P-->>E: unanswered prompt rows
  E-->>Ph: 200 [ {id, question, answer_schema, ...} ]
  Ph->>Ph: user answers
  Ph->>E: POST /functions/v1/prompt-answer<br/>Bearer: phone token<br/>Body: { prompt_id, answer_event_id, data }
  E->>P: SELECT ingest_api.accept_prompt_answer(token, prompt_id, answer_event_id, data)
  P->>P: atomic: UPDATE prompts SET answered_at=NOW();<br/>INSERT events (id, device='phone', source='prompt.<kind>', data, ts)
  P-->>E: event id
  E-->>Ph: 200
  Note over O: next scheduled run sees the answer as a normal event
```

### C. Scheduled agent job (daily-digest example)

```mermaid
sequenceDiagram
  autonumber
  participant S as Orchestrator scheduler
  participant A as Agent runtime
  participant P as Postgres
  participant L as Anthropic API
  S->>A: trigger daily-digest job (07:00 local)
  A->>P: SELECT * FROM events_enriched WHERE timestamp_utc > NOW() - INTERVAL '24h'<br/>as agent_role
  P-->>A: rows
  A->>A: load skills/memory from local FS
  A->>L: POST /v1/messages with prompt + rows + prior context
  L-->>A: narrative markdown
  A->>P: SELECT agent_api.upsert_report(NULL, 'daily 2026-04-20', body, tags, ws, we)<br/>as agent_role
  P->>P: INSERT public.reports
  A->>A: write summary + decisions to local memory/
```

Weekly-report and prompt-asker are the same shape with different
windows and prompts. Classifier is the same shape but uses
Groq/Cerebras and writes via a `agent_api.classify_event` RPC
(introduced as part of roadmap #8).

### D. Swift dashboard chat

```mermaid
sequenceDiagram
  autonumber
  participant U as You
  participant S as Swift app
  participant O as Orchestrator /chat
  participant A as Agent runtime
  participant P as Postgres
  U->>S: ask question
  S->>O: WSS open + first message (user token auth)
  O->>A: spawn agent session<br/>inject agent_role DSN + user's message
  A->>P: SELECTs as agent_role
  A-->>O: streaming tokens
  O-->>S: streaming tokens
  Note over A: agent may call agent_api.upsert_* mid-session
  S-->>U: render
```

### E. Admin CLI lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant J as You
  participant C as ./admin (local)
  participant K as Mac Keychain
  participant P as Postgres (service_role direct)
  participant SS as Supabase secrets (CLI)
  J->>C: ./admin device add phone --label "Pixel 9" --platform android
  C->>P: INSERT public.devices
  J->>C: ./admin setup-roles
  C->>P: ALTER ROLE ingest_role WITH LOGIN PASSWORD <random>
  C->>P: ALTER ROLE user_role   WITH LOGIN PASSWORD <random>
  C->>P: ALTER ROLE agent_role  WITH LOGIN PASSWORD <random>
  C->>K: keyring.set_password scrollantir/ingest-role
  C->>K: keyring.set_password scrollantir/user-role
  C->>K: keyring.set_password scrollantir/agent-role
  C-->>J: print "supabase secrets set INGEST_DATABASE_URL=..."
  J->>SS: supabase secrets set INGEST_DATABASE_URL=...
  Note over J: separately, copy agent-role DSN from Keychain to orchestrator env
  J->>C: ./admin mint --device-id phone
  C->>P: INSERT private.tokens (sha256 of plaintext)
  C-->>J: QR code + prefix (plaintext shown once)
```

## Trust + credential map

| Credential | Where it lives | What compromise buys an attacker |
|---|---|---|
| `service_role` DSN | `scripts/.env.admin` on your Mac only | Full DB. Keep this machine secure; nowhere else. |
| `user_role` DSN | Mac Keychain (`scrollantir/user-role`) | SELECT `public.*`, CRUD derived tables + `source_tags`. No events modification, no private. |
| `agent_role` DSN | Mac Keychain **and** orchestrator env | SELECT `public.*`, singleton writes via `agent_api.*`. Can't mass-mutate, can't touch `private.*`, can't `DELETE`. |
| `ingest_role` DSN | Supabase function secret `INGEST_DATABASE_URL` | Only `ingest_api.*` RPCs. Can't SELECT anything, can't read tokens. |
| Device bearer tokens | `EncryptedSharedPreferences` (phone); Keychain entry TBD (Mac) | POST events as that device. Revocable via admin CLI. |
| LLM API keys | Orchestrator env only | Bill fraud; no data-plane access. |

The rule of thumb: **`service_role` leaves your admin Mac only to be
installed as a DSN via Supabase CLI.** Everything else is scoped down
to the smallest role that does the job.

## Where the LLM runs

Exactly one place: **the orchestrator**. It makes HTTPS calls to one
or more of {Anthropic, Groq, Cerebras}. LLMs never run:

- On device — battery and latency cost, no upside.
- In edge functions — Deno 150 s timeout + 512 MB RAM + no persistent
  FS make real agent runtimes infeasible; cost-per-invocation also
  climbs badly for long reasoning.
- On the admin Mac — you want scheduled jobs to tick even when your
  laptop is closed.

The orchestrator pattern explicitly recovers three things the edge
functions can't offer: **persistent filesystem** (skills, memory,
accumulated state), **long-running processes** (streaming chat,
multi-tool reasoning), and **pluggable tool inventory** (agent runtime
can shell out, use git, run Python).

## What the orchestrator server needs to provide

Minimum viable spec. This is what you should shop for.

1. **Always-on Linux host.** 1 vCPU / 1 GB RAM is fine to start; 2
   vCPU / 2 GB more comfortable. No GPU. No high IOPS. Traffic is
   trivial (a few KB of DB queries + a few MB of LLM round-trips per
   day).
2. **Persistent disk (~5 GB).** Skills, memory, logs. Separate from
   container lifetime — redeploys must not wipe `/var/scrollantir/*`.
3. **TLS-terminated HTTPS endpoint** for the Swift app chat
   (`wss://orch.yourdomain/chat`). Let's Encrypt + Caddy is trivial.
   Self-signed is fine for a while since the only client is your Mac.
4. **Outbound HTTPS** to `*.supabase.co:5432` (Postgres) and to LLM
   provider APIs.
5. **Environment secrets**: `AGENT_DATABASE_URL`, `ANTHROPIC_API_KEY`,
   optional `GROQ_API_KEY` / `CEREBRAS_API_KEY`.
6. **Cron or systemd timers** (host-level is fine; no need for a
   scheduler library).

Candidate shapes:
- Hetzner / DigitalOcean / Linode cheapest tier (~$4-6/mo) with
  Docker Compose.
- Fly.io with a persistent volume + machines (min=1) — can be a single
  Dockerfile with persistence.
- Mac mini at home running Tailscale — only viable if you're OK with
  home ISP dependency; cheapest long-term.
- A container on an existing server you already run (cheapest if you
  have one).

Not suitable: Cloudflare Workers, Vercel serverless, AWS Lambda
(short timeouts, no persistent FS, cold starts). These are edge-fn
shaped, which is what we specifically moved away from for the
reasoning plane.

## Open questions (to resolve before orchestrator work starts)

1. **Agent runtime choice.** Claude Code CLI? Codex CLI? A bespoke
   Python loop around `anthropic.messages.create`? Codex CLI is
   Josh's stated preference; worth prototyping all three.
2. **Chat transport to Swift.** Plain SSE vs. WebSocket? SSE is
   simpler; WS supports user-interrupt upstream.
3. **How `agent_role` DSN reaches the orchestrator.** Options:
   `ssh + scp` after `setup-roles`; pull from 1Password CLI; manual
   one-time paste into the VPS env. Pick one, document in
   `docs/setup.md` when the orchestrator ships.
4. **Classifier latency.** Per-event-as-it-arrives (orchestrator
   subscribes to events changes) vs. 15-min batches. Batches are
   simpler and fit the orchestrator's periodic-job shape; subscription
   means the orchestrator needs an always-open listener on Postgres
   LISTEN/NOTIFY. Default to batches.
5. **Whether pg_cron tasks stay on Supabase.** Small DB-only jobs
   (auto-revoke superseded tokens, delete old rate-limit rows) belong
   on `pg_cron` since they don't need the orchestrator's runtime.
   Everything with an LLM call belongs on the orchestrator.

## Related docs

- `architecture.md` — data model, source naming, Pattern B collection
- `supabase.md` — schemas, roles, RPC contracts, RLS posture
- `admin-cli.md` — the local CLI this data flow depends on
- `edge-functions.md` — ingest/prompt-answer/pending-prompts detail
- `agent.md` — agent conventions (predates the orchestrator
  architecture; will need a pass once the server shape is decided)
- `dashboard.md` — Swift dashboard design
- `roadmap.md` — shipping order
