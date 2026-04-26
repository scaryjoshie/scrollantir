# orchestrator/

Docker image + runtime files for the scrollantir reasoning plane.
Spec: `../docs/runtime/README.md`. Data flow: `../docs/data-flow.md`.

## Layout

```
orchestrator/
├── Dockerfile           # ubuntu:24.04 + psql + cron + node + Claude Code CLI
├── entrypoint.sh        # renders crontab, writes .pgpass, rsyncs runtime → volume
├── run-job.sh           # one-shot: claude -p < jobs/<name>.md, with logging
├── crontab.template     # schedule (America/Chicago)
├── .dockerignore
└── runtime/             # COPY'd into image at /app/runtime/; rsynced to /scrollantir on boot
    ├── CLAUDE.md        # agent operating manual (in-container version)
    ├── jobs/
    │   ├── smoke.md
    │   └── daily-digest.md
    └── skills/          # empty to start; grows over time
```

`runtime/memory/` and `runtime/logs/` are deliberately absent — they
are runtime-only state, created on the volume by `entrypoint.sh`
(mode 700). Never in git, never in the image.

## Local smoke (Phase 1)

```bash
export AGENT_DATABASE_URL="$(security find-generic-password -s scrollantir -a agent-role -w)"
export ANTHROPIC_API_KEY="<paste>"

docker build -t scrollantir-orchestrator orchestrator/

# One-shot smoke: writes a ['smoke']-tagged report and exits.
docker run --rm \
  -e ANTHROPIC_API_KEY \
  -e AGENT_DATABASE_URL \
  -v scrollantir-data:/scrollantir \
  scrollantir-orchestrator \
  smoke

# Same shape, real job.
docker run --rm \
  -e ANTHROPIC_API_KEY \
  -e AGENT_DATABASE_URL \
  -v scrollantir-data:/scrollantir \
  scrollantir-orchestrator \
  daily-digest
```

After either run, confirm via:

```bash
psql "$AGENT_DATABASE_URL" -c \
  "SELECT id, title, created_at, tags FROM public.reports
   ORDER BY created_at DESC LIMIT 3"
```

## Deployment (Phase 2)

Oracle Free ARM VM + systemd + a bind-mounted volume at
`/opt/scrollantir/data:/scrollantir`. Full bootstrap in
`../docs/runtime/README.md` §"Phase 2".

Artifacts:
- `systemd/scrollantir-orchestrator.service` — systemd unit.
- `systemd/scrollantir.env.example` — template for
  `/etc/scrollantir.env` (mode 600; secrets live here only).

## Updating in production

Two tiers, optimized for how often each thing changes:

| Change | Script | Time | Restart? |
|---|---|---|---|
| `runtime/jobs/*.md`, `runtime/CLAUDE.md`, `runtime/skills/*` | `./sync-runtime.sh` | ~2 s | No |
| Dockerfile, `entrypoint.sh`, `run-job.sh`, `crontab.template`, image bumps | `./deploy.sh` | ~1 min | Yes |

Both run from your Mac against an SSH alias:

```bash
export SCROLLANTIR_VM=orch           # ssh host alias

./orchestrator/sync-runtime.sh       # fast iteration (rsync only)
./orchestrator/deploy.sh             # git pull + rebuild + systemctl restart + smoke
```

`sync-runtime.sh` uses `rsync --rsync-path="sudo rsync"` so the SSH
user needs passwordless sudo for rsync — the Ubuntu default on
Oracle Free. `deploy.sh` needs passwordless sudo for `systemctl`
and docker.

`memory/` and `logs/` on the volume are never touched by
`sync-runtime.sh`. The agent owns those; stomping them would drop
the `last-success-<job>` markers and the run trail.
