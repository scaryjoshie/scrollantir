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
# set POSTGRES_PASSWORD (any non-empty value for dev)
docker compose up -d
docker compose ps                       # all 5 services healthy
curl http://localhost/health            # → {"ok":true}
docker compose logs -f agent            # tick lines once a minute
```

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

## v0 caveats (this commit)

Commit #1 proves orchestration. It does **not** yet have:

- A real schema. PostgREST connects as the postgres superuser; the
  `authenticator` / `anon` / `ingest_role` / `user_role` / `agent_role`
  split lands in commit #2 alongside the `db/schemas/` port from
  `supabase/schemas/`.
- A migrations runner. `dbmate` against the live DB is the planned
  tool.
- Any deriver, model, or DB-access code in `app/src/scrollantir/`.
- A real `forward()`/`complete()` scheduler. The current `agent`
  ticks once a minute and logs "tick".

## Local-dev override

`compose.override.yaml` (gitignored) is the place to bind-mount source
into the api container so uvicorn `--reload` picks up edits without a
rebuild:

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

The override is auto-merged when present. The Hetzner VM never has it,
so production always uses the baked image.
