#!/usr/bin/env bash
# orchestrator/sync-runtime.sh — fast prompt iteration against the VM.
#
# Rsyncs orchestrator/runtime/ (CLAUDE.md + jobs/*.md + .claude/settings.json
# + skills/) to the VM's bind-mounted volume, bypassing the container
# image. The next cron tick — or any manual `run-job.sh <job>` — picks
# up the new prompts without a restart or rebuild.
#
# Use this when you're iterating on prompts or skills. For Dockerfile,
# entrypoint.sh, run-job.sh, or crontab changes, use ./deploy.sh
# instead (those require a rebuild).
#
# Usage:
#   export SCROLLANTIR_VM=orch.example              # ssh host or alias
#   ./orchestrator/sync-runtime.sh
#
# Optional:
#   SCROLLANTIR_VM_DATA=/opt/scrollantir/data       # override volume path
#
# Requirements on the VM:
#   - /opt/scrollantir/data exists (bind-mount target, set up during
#     Phase 2 bootstrap)
#   - The SSH user can `sudo rsync` without a password (Ubuntu default
#     on Oracle Free; otherwise set NOPASSWD for rsync in sudoers)
#
# Notes:
#   - Excludes memory/ and logs/ so we never stomp agent-written state.
#   - Does NOT pass --delete. If you rename a job file, the old one
#     stays on the volume until you remove it manually:
#         ssh $SCROLLANTIR_VM sudo rm /opt/scrollantir/data/jobs/old.md

set -euo pipefail

: "${SCROLLANTIR_VM:?set SCROLLANTIR_VM=ssh-host[:port] (try: export SCROLLANTIR_VM=orch.example)}"
data_dir="${SCROLLANTIR_VM_DATA:-/opt/scrollantir/data}"

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/runtime/"

if [[ ! -d "$src" ]]; then
  echo "missing source dir: $src" >&2
  exit 1
fi

echo "→ syncing $src → ${SCROLLANTIR_VM}:${data_dir}/"
rsync -av --itemize-changes \
  --rsync-path="sudo rsync" \
  --exclude='memory/' \
  --exclude='logs/' \
  "$src" \
  "${SCROLLANTIR_VM}:${data_dir}/"

echo
echo "✓ sync complete. Validate with:"
echo "    ssh ${SCROLLANTIR_VM} sudo docker exec scrollantir-orchestrator run-job.sh smoke"
