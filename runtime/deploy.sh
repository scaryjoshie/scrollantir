#!/usr/bin/env bash
# scrollantir runtime — redeploy api + agent on Hetzner.
#
# Pulls main, rebuilds the Python image, recreates only api + agent.
# Postgres, PostgREST, Caddy untouched. Named volumes survive.
#
# Usage:    SCROLLANTIR_VM=<ssh-alias> ./deploy.sh
# Prereqs:  repo cloned at /opt/scrollantir/repo on the VM,
#           /opt/scrollantir/repo/runtime/.env populated, mode 0600.

set -euo pipefail

: "${SCROLLANTIR_VM:?set SCROLLANTIR_VM (ssh alias)}"

ssh "$SCROLLANTIR_VM" '
  set -euo pipefail
  cd /opt/scrollantir/repo
  git pull --ff-only
  cd runtime
  docker compose build api agent
  docker compose up -d --no-deps api agent
  docker compose ps
'
