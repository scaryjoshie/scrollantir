# Scrollantir — Self-host plan

How to replace Supabase with a self-hosted Docker Compose stack on a
single VM (Hetzner / Oracle Free / similar). Designed to be the
default deployment for the open-sourced project.

Read `docs/data-flow.md` first for the current shape; this doc
describes the target replacement of the Supabase-hosted pieces
(Postgres + edge functions) with self-hosted equivalents.

## Status

📝 Architecture finalized — ready for implementation.

Decision drivers:

- Open-source friendliness: project ref leaks (`feijpewzqgqczkxmvdng`)
  embedded in QR payloads, setup scripts, docs.
- "Palantir for myself" ethos — own the data plane end to end.
- Existing coupling to Supabase is thin: vanilla Postgres roles +
  RPCs, ~70-line Deno edge function. Migration cost is low.
- Existing data is disposable; clean cutover is acceptable.

## Goals

1. **One Docker Compose file** describes the entire data plane.
2. **One public entry point** (Caddy on 443) routes to internal HTTP
   services. Postgres is never exposed externally.
3. **Open-source-friendly setup**: clone, point a domain, fill `.env`,
   `docker compose up`, register devices via admin CLI. Under 15
   minutes for someone who's never seen the project.
4. **No SaaS dependency** beyond Let's Encrypt's ACME (which is the
   same dependency every HTTPS service has). No Tailscale, no
   Cloudflare, no managed databases.
5. **Modular**: each service in the stack is replaceable without
   touching the others. Postgres knows nothing about Caddy, PostgREST
   knows nothing about FastAPI, and vice versa.

## Architecture

```
                    PUBLIC INTERNET
                          │
                          ▼
   ┌────────────────── Hetzner VM ─────────────────────────┐
   │                                                       │
   │   Caddy:443 ──┬──▶ PostgREST  ──▶ Postgres            │
   │   (auto-TLS)  │                       ▲               │
   │               └──▶ FastAPI    ──┐     │               │
   │                   (chat, future)│     │               │
   │                                 ▼     │               │
   │                              orchestrator             │
   │                              (cron + Claude Code)     │
   │                                                       │
   │   sshd:22 (key-only)                                  │
   │                                                       │
   └───────────────────────────────────────────────────────┘
              ▲
              │ HTTPS (devices)
              │ HTTPS (browser)
              │ SSH (you, for admin)
              │
        public clients
```

**Public surface:** ports 22 (SSH, key-only) and 443 (Caddy).
Postgres lives entirely on the Docker network and is never exposed.

**Public entry point:** Caddy is the single front door. It terminates
TLS, routes by hostname to the right backend HTTP service, and
auto-provisions Let's Encrypt certs.

**Data API:** PostgREST translates HTTPS+JWT to Postgres role-based
RPC calls. It's what Supabase wraps internally. Devices, the
dashboard, and the admin CLI all hit PostgREST endpoints.

**Custom services:** FastAPI (or any HTTP framework) for things
PostgREST can't do — streaming chat, external API calls, complex
orchestration. Sits behind Caddy alongside PostgREST.

**Admin/debugging:** SSH into the VM, run `psql` or `./admin` locally
on the box. No tunnel, no VPN — bastion-style access via stock SSH.

## Service inventory

| Service | Purpose | Container |
|---|---|---|
| Caddy | TLS termination, reverse proxy by hostname | yes |
| PostgREST | Auto-generated REST API over Postgres schema, JWT auth | yes |
| FastAPI (`chat-service`) | Chat / agent surface; endpoints PostgREST can't cover | yes (future) |
| Postgres 17 | Source of truth | yes (internal only) |
| Orchestrator | Existing — cron + Claude Code, talks to Postgres directly | yes (existing) |
| Mac forwarder | Existing — emits events via HTTPS | n/a (lives on Mac) |
| Android app | Existing — emits events via HTTPS, polls prompts | n/a (lives on phone) |
| Admin CLI | Existing — runs on the VM via SSH (or locally during dev) | n/a |

**New services vs. today:** Caddy + PostgREST. (FastAPI added later
when chat ships.) Postgres is a 1:1 swap from Supabase. The
orchestrator is unchanged except for its `AGENT_DATABASE_URL` target.

## Network surface

```
Public:
  :22  sshd          key-only auth, fail2ban backstop
  :443 caddy         TLS termination, reverse-proxy to backends

Docker bridge (internal, never exposed):
  postgrest:3000     ← caddy reverse_proxy target
  chat-service:8000  ← caddy reverse_proxy target (future)
  postgres:5432      ← postgrest, chat-service, orchestrator
  orchestrator       ← talks to postgres directly
```

The `expose:` directive (not `ports:`) is used for all internal
services so Docker doesn't publish them to the host. Only Caddy and
sshd have public bindings.

## Auth model

### Bearer tokens vs. JWTs

PostgREST natively expects JWTs (signed, stateless). The current
ingest flow uses opaque bearer tokens stored hashed in
`private.tokens` (revocable via DB row update). Two paths:

**Path A (recommended for migration): keep bearer tokens, hybrid mode.**
- Devices send `POST /rpc/accept_event` to PostgREST with no JWT (or
  with an anonymous JWT).
- The bearer token is passed as an RPC parameter in the body.
- `accept_event` validates the token server-side as it does today.
- Existing revocation model (token row update) stays intact.
- Zero device-side changes beyond URL.

**Path B (cleaner long-term): migrate to JWTs.**
- `./admin mint` issues a signed JWT containing `role: ingest_role`,
  `device_id: ...`, `exp: ...`.
- PostgREST verifies the signature, sets the role, runs the RPC.
- Revocation requires either short-lived JWTs + refresh, or a
  blacklist table checked by RPCs.
- Cleaner PostgREST integration; bigger initial change.

**Default plan:** ship with Path A. Migrate to Path B if/when the
revocation model becomes annoying. Both paths share the same
`JWT_SECRET` env var, so any FastAPI services added later can verify
JWTs from the same auth domain without rework.

### Postgres role separation (unchanged)

The Postgres-side security model carries over verbatim:

- `ingest_role`: NOLOGIN, EXECUTE on `ingest_api.*` only.
- `user_role`: SELECT on `public.*`, CRUD on derived tables.
- `agent_role`: SELECT on `public.*`, EXECUTE on `agent_api.*`.
- `service_role` / superuser: admin only, never shipped to a service.

PostgREST switches roles based on JWT claims (Path B) or runs as the
anonymous role and lets RPCs check the bearer token (Path A).

## Repo layout (target)

```
scrollantir/
├── docker-compose.yml             # base — service definitions
├── docker-compose.override.yml    # local dev overrides (gitignored)
├── docker-compose.prod.yml        # prod overrides (in-repo)
├── Caddyfile                      # reverse proxy + TLS config
├── .env.example                   # documented placeholders
├── README.md                      # one-command quickstart
├── services/
│   ├── postgrest/                 # PostgREST config, optional Dockerfile
│   ├── chat-service/              # FastAPI chat (future)
│   └── postgres/
│       └── init/                  # roles + extensions + seed SQL
├── db/
│   ├── schemas/                   # declarative source (current supabase/schemas)
│   └── migrations/                # numbered forward-only SQL
├── orchestrator/                  # existing, unchanged
├── clients/
│   ├── android/
│   ├── mac-forwarder/
│   └── mac-extension/
├── admin/                         # Python admin CLI (currently scripts/admin.py)
└── docs/
```

## Postgres init flow

Replaces `supabase db push`. On first container boot:

1. Postgres image runs `/docker-entrypoint-initdb.d/*.sql` once.
2. We mount `services/postgres/init/` containing:
   - `00-extensions.sql` — `CREATE EXTENSION pgcrypto`, `pg_cron`. In
     vanilla Postgres these go in `public`, so callsites drop the
     `extensions.` qualifier (one find/replace in `db/schemas/`).
   - `10-schemas.sql` … `40-grants.sql` — current `supabase/schemas/`
     content, lightly cleaned.
   - `50-roles.sql` — creates `ingest_role`, `user_role`, `agent_role`,
     `authenticator` (PostgREST entry role) with passwords from env.
3. Ongoing schema changes go through `db/migrations/<ts>_*.sql`
   applied by a small bash runner using a `schema_migrations` tracking
   table. No migration framework dependency.

## PostgREST configuration

Single container, configured via env vars:

```yaml
postgrest:
  image: postgrest/postgrest:v12
  expose: ["3000"]
  environment:
    PGRST_DB_URI: postgres://authenticator:${AUTHENTICATOR_PW}@postgres:5432/scrollantir
    PGRST_DB_SCHEMAS: public,ingest_api,agent_api
    PGRST_DB_ANON_ROLE: anon
    PGRST_JWT_SECRET: ${JWT_SECRET}
```

`authenticator` is a NOLOGIN-passthrough role; PostgREST switches to
the role specified in JWT claims (or to `anon` for unauthenticated
requests, which is then the role that runs RPCs in Path A).

## Caddy configuration

```
ingest.scrollantir.com {
    reverse_proxy postgrest:3000
}

dashboard.scrollantir.com {
    basic_auth { josh ${DASHBOARD_BCRYPT} }
    reverse_proxy postgrest:3000
}

# Future, when chat ships:
# chat.scrollantir.com {
#     reverse_proxy chat-service:8000
# }
```

Three Caddy concerns: hostname routing, TLS via Let's Encrypt
(automatic), and (optionally) basic_auth in front of the dashboard
since the dashboard browser doesn't carry a bearer/JWT itself.

## Endpoints (initial set)

Phone / Mac forwarder writes:
```
POST  https://ingest.scrollantir.com/rpc/accept_event
POST  https://ingest.scrollantir.com/rpc/accept_events     (batch)
GET   https://ingest.scrollantir.com/rpc/pending_prompts
POST  https://ingest.scrollantir.com/rpc/accept_prompt_answer
```

Dashboard reads (browser, behind basic_auth):
```
GET   https://dashboard.scrollantir.com/events_enriched?...
GET   https://dashboard.scrollantir.com/reports?...
GET   https://dashboard.scrollantir.com/rpc/summary?...
```

The dashboard's existing `dashboard/server/blocks.ts` /
`summarize.ts` logic moves either to PL/pgSQL views (exposed
automatically by PostgREST) or to browser-side TypeScript. At
personal scale, browser-side coalescing of a few thousand events is
millisecond work and probably the simpler path.

The current Vite dev-server pattern (`dashboard/vite-plugins/api.ts`
holding the DSN) goes away — the browser hits PostgREST directly via
Caddy, no laptop-side server needed. Removes the macOS-Keychain
dependency from the dashboard entirely.

## Admin / ops

No tunnel, no VPN. Admin operations run on the VM:

```bash
ssh hetzner-scrollantir
./admin device add --label "phone" --platform android
docker exec -it scrollantir-postgres psql -U service_role scrollantir
```

For ad-hoc queries, SSH in and run psql in the Postgres container.
Native Postgres tools (pgAdmin, Postico) from your laptop are not
supported by default — by design, since avoiding that need is what
lets us drop Tailscale.

If you ever want native-tool access, the simplest path is `ssh -L
5432:postgres:5432 hetzner-scrollantir` per session. No persistent
infrastructure required.

## Security: minimum essential set

Compose defaults bake these in so users don't have to think about
them:

1. Postgres uses `expose:` (Docker-internal only), never `ports:`.
2. `pg_hba.conf` allows `scram-sha-256` from the Docker bridge only;
   rejects everything else.
3. Caddy auto-provisions TLS via Let's Encrypt.
4. Backend containers (postgrest, chat-service) run non-root with
   dropped capabilities and read-only root filesystems.
5. Image versions pinned. `.env` mode 0600, in `.gitignore`.

Public ports: 22 (key-only SSH, fail2ban) and 443 (Caddy). That's the
entire attack surface.

User does at deploy time:

1. Buy a host (Hetzner CAX11 ~€4/mo, or Oracle Free, or self-host
   on a Mac mini with port forwarding).
2. Point a domain (`scrollantir.example.com` and subdomains) at the
   VM's public IP.
3. `cp .env.example .env`, fill in 5 secrets:
   `DOMAIN`, `JWT_SECRET`, `AUTHENTICATOR_PW`, `INGEST_PW`,
   `USER_PW`, `AGENT_PW`, `DASHBOARD_BCRYPT`.
4. `docker compose up -d`.
5. SSH in: `./admin device add` + `./admin mint` to register devices.
6. Re-mint QR for phone, update Mac forwarder Keychain entry to new
   ingest URL.

Optional hardening (documented, not enforced): restic to B2 nightly,
1Password CLI for secrets, Renovate for image updates, fail2ban,
unattended-upgrades.

## Migration from Supabase

Data is disposable; flag-day cutover is fine.

1. Build compose stack, get green locally (`docker compose up` on
   laptop, run a synthetic event through PostgREST).
2. Provision the VM, point DNS, deploy the prod stack.
3. SSH in: `./admin device add` + mint fresh tokens against the new DB.
4. Re-scan QR on phone, update Mac forwarder Keychain entry.
5. Verify events flow.
6. Tear down or freeze Supabase project.

No dual-write, no parity check. The deterministic uuid5 on Mac means
re-ingesting old data into the new DB later is also safe if you change
your mind.

## Implementation plan

Phased so each phase is independently testable.

### Phase 1 — Local compose green path

1. Write base `docker-compose.yml` with postgres, postgrest, caddy.
2. Port `supabase/schemas/*.sql` → `db/schemas/` + `services/postgres/init/`.
   Drop the `extensions.` schema qualifier on pgcrypto.
3. Add `db/migrations/` with a small bash runner.
4. Write Caddyfile with `ingest.localhost` route to postgrest.
5. Bring it up locally; verify `POST /rpc/accept_event` works with a
   hand-crafted bearer token.

### Phase 2 — Client cutover

6. Update Android `IngestClient.kt` to point at PostgREST URL form
   (`/rpc/accept_event` instead of `/ingest`). Adjust payload shape
   if needed.
7. Update Mac forwarder similarly.
8. Update `./admin mint` to print a QR with the new URL format.
9. Re-mint a test phone token; verify ingest end-to-end.

### Phase 3 — VM deploy

10. Provision Hetzner VM (or chosen host).
11. Point DNS for `ingest.<domain>` and `dashboard.<domain>`.
12. Copy `.env`, `docker compose up -d`.
13. Re-mint production tokens, repoint phone + Mac forwarder.
14. Soak for a week.

### Phase 4 — Dashboard

15. Move dashboard's `server/` logic to browser-side or PL/pgSQL views.
16. Drop the Vite `apiPlugin` and Keychain DSN flow.
17. Add Caddy `dashboard.<domain>` route with basic_auth.
18. Browser fetches PostgREST directly via Caddy.

### Phase 5 — Decommission Supabase

19. Verify no client still points at Supabase.
20. Freeze the Supabase project (don't delete — keeps option to
    consult historical data).

### Phase 6 — Chat service (deferred)

21. Add FastAPI chat-service to compose with shared `JWT_SECRET`.
22. Add Caddy route for `chat.<domain>`.
23. Implement streaming chat endpoint.

## Open questions

- **Dashboard transforms in PL/pgSQL vs. browser.** Block coalescing
  in `server/blocks.ts` is the only piece with real algorithmic
  weight. Browser-side is simpler; PL/pgSQL views give caching.
  Decide during Phase 4.
- **pg_cron in vanilla Postgres**: requires `shared_preload_libraries`
  + `cron.database_name`. Postgres init scripts handle this; verify
  the official image's permissions allow the config edit (or use
  a Postgres image that bundles pg_cron preconfigured).
- **Backup tooling default**: restic vs. plain `pg_dump` cron.
  Probably restic — single binary, encryption built in, B2 native.
- **Migration runner**: pure bash with `schema_migrations` table is
  the minimum. Worth comparing to `dbmate` for slightly better error
  reporting before committing.

## What this changes in other docs

After implementation, these docs will need updates:

- `architecture.md` — pipeline diagram needs the self-host shape.
- `data-flow.md` — credential map shifts from Supabase secrets to
  `.env` on the VM + JWT_SECRET shared across services.
- `supabase.md` — retitle / split. The schema/role/RPC content is
  still authoritative; the Supabase-specific deployment notes
  become a historical appendix.
- `edge-functions.md` — replaced by an "endpoints" doc covering the
  PostgREST URL contract and any FastAPI endpoints.
- `setup.md` — fresh quickstart targeting the compose flow.

`orchestrator.md` is untouched — the orchestrator is already a
container, only its `AGENT_DATABASE_URL` target changes.
