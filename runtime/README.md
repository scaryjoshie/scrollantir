# scrollantir runtime

Self-hosted backend stack. Replaces the bash-shaped `orchestrator/` POC
and the Supabase data plane in one folder: Caddy + PostgREST + Postgres
for the data API, FastAPI + APScheduler-driven agent for everything
PostgREST can't do.

See [`docs/runtime/rebuild-plan.md`](../docs/runtime/rebuild-plan.md)
for the design rationale and
[`docs/runtime/self-host.md`](../docs/runtime/self-host.md) for the
data-plane shape.

## Services

| Service   | Image                          | Purpose |
|-----------|--------------------------------|---------|
| caddy     | `caddy:2-alpine`               | TLS + reverse proxy |
| postgres  | `postgres:17-alpine`           | Data plane |
| postgrest | `postgrest/postgrest:v12.2.3`  | Auto-REST over Postgres |
| api       | `./app` (Python)               | FastAPI — chat + things PostgREST can't do |
| agent     | `./app` (same image)           | APScheduler — cron-fired derivers + 60s complete() poll |

`api` and `agent` share one image (`./app/Dockerfile`) and run as two
compose services with different `command:` directives.

## Run locally

```bash
cd runtime
cp .env.example .env
# Set the four required passwords (POSTGRES_PASSWORD, AUTHENTICATOR_PW,
# USER_PW, AGENT_PW). For dev, any non-empty values work; in production
# generate strong random ones (e.g. `openssl rand -hex 32`).
docker compose up -d
docker compose ps                       # all 5 services healthy
curl http://localhost/health            # → {"ok":true}
curl http://localhost/                  # → PostgREST OpenAPI doc
docker compose logs -f agent            # tick lines once a minute
```

First boot runs every `*.sql` and `*.sh` in `db/schemas/` against a
fresh data volume, in alphabetical order — extensions, schemas, roles,
tables, seed, grants. Subsequent boots skip init and just start the
existing DB.

## Restart cleanly

```bash
docker compose down                       # containers gone; volumes survive
docker compose up -d                      # picks up where postgres/caddy left off
docker volume rm scrollantir_postgres_data  # ONLY to wipe the DB
```

## Deploy to Hetzner

```bash
SCROLLANTIR_VM=hetzner ./deploy.sh
```

Pulls `main` on the VM, rebuilds the Python image, recreates only
`api` + `agent`. Postgres / PostgREST / Caddy untouched. Named volumes
(`postgres_data`, `caddy_data`, `caddy_config`) survive everything
except `docker volume rm`.

## What's still missing

The schema foundation is in place — extensions + roles + 8 public + 2
private tables, mounted from `db/schemas/` into postgres init on first
boot. Beyond that, still pending:

- **`ingest_api.*` RPCs** — `accept_event`, `accept_prompt_answer`,
  `pending_prompts`. Devices can't post events until these land.
- **Views** — `events_enriched`, `mac_active`, `phone_active`,
  `phone_activity_gated`, etc.
- **`agent_api.*` RPCs** — `upsert_report`, `upsert_annotation`,
  `create_prompt`, `replace_derived_window`.
- **Migrations runner** — `dbmate` against the live DB once a real
  forward-only migration is needed.
- **Deriver / model / db-access Python code** — `app/src/scrollantir/`
  is still skeletal beyond the api `/health` endpoint and the agent
  tick stub.
- **Real `forward()` / `complete()` scheduling** — the agent currently
  just ticks once a minute.
- **Client cutover** — android/ + mac-forwarder/ + dashboard/ still
  point at Supabase. The local stack will receive its first real event
  only after `accept_event` ships and clients re-mint tokens.

## Local-dev override

`compose.override.yaml` (gitignored) is auto-merged when present. The
Hetzner VM never has it, so production always uses internal-only
networking + the baked image.

**Bind-mount source for live reload:**

```yaml
services:
  api:
    volumes:
      - ./app/src:/app/src:ro
    command:
      - uvicorn
      - scrollantir.api.main:app
      - --host
      - 0.0.0.0
      - --port
      - "8000"
      - --reload
```

**Expose postgres for the admin CLI** (so `./admin local mint …` can
reach it from the host shell):

```yaml
services:
  postgres:
    ports:
      - "55432:5432"
```

Then on your Mac:

```bash
export SCROLLANTIR_LOCAL_DSN="postgresql://scrollantir:$(grep ^POSTGRES_PASSWORD runtime/.env | cut -d= -f2)@localhost:55432/scrollantir"
export SCROLLANTIR_INGEST_URL="http://localhost"   # or the nip.io URL post-deploy
./admin local mint --device-id phone --show-token
```

Both blocks can coexist in the same override file.
