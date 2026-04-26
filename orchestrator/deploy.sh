#!/usr/bin/env bash
# orchestrator/deploy.sh — rebuild + restart the orchestrator on the VM.
#
# For Dockerfile / entrypoint.sh / run-job.sh / crontab changes — i.e.
# anything that requires rebuilding the image. For prompt-only edits
# (jobs/*.md, CLAUDE.md, skills/), prefer ./sync-runtime.sh — it's
# much faster and doesn't restart cron.
#
# Usage:
#   export SCROLLANTIR_VM=orch.example          # ssh host or alias
#   ./orchestrator/deploy.sh
#
# What this does on the VM:
#   1. git pull --ff-only in /opt/scrollantir/repo
#   2. docker build -t scrollantir-orchestrator orchestrator/
#   3. sudo systemctl restart scrollantir-orchestrator
#   4. sudo docker exec ... run-job.sh smoke   (validate)
#   5. tail last-success-smoke + memory/log.md
#
# Requirements on the VM (done once during Phase 2 bootstrap):
#   - /opt/scrollantir/repo is a clone of this repo (your fork if private)
#   - /opt/scrollantir/data exists (bind-mount for /scrollantir)
#   - /etc/scrollantir.env is populated with the secrets (mode 600)
#   - systemd unit installed + enabled:
#       sudo systemctl enable --now scrollantir-orchestrator
#   - The SSH user has passwordless sudo for systemctl + docker (Ubuntu
#     default on Oracle Free once the user is added to the docker group).

set -euo pipefail

: "${SCROLLANTIR_VM:?set SCROLLANTIR_VM=ssh-host[:port]}"
repo_dir="${SCROLLANTIR_VM_REPO:-/opt/scrollantir/repo}"

run() {
  echo "→ $*"
  # shellcheck disable=SC2029
  ssh -o BatchMode=yes "${SCROLLANTIR_VM}" "$*"
}

run "cd ${repo_dir} && git pull --ff-only"
run "cd ${repo_dir} && docker build -t scrollantir-orchestrator orchestrator/"
run "sudo systemctl restart scrollantir-orchestrator"

echo "→ waiting 5s for cron daemon to settle"
sleep 5

echo "→ smoke test"
run "sudo docker exec scrollantir-orchestrator /usr/local/bin/run-job.sh smoke"

echo "→ verifying smoke marker + trail"
run "sudo cat /opt/scrollantir/data/memory/last-success-smoke"
run "sudo tail -3 /opt/scrollantir/data/memory/log.md"

echo
echo "✓ deploy complete. Today's digest will run at 07:00 America/Chicago."
