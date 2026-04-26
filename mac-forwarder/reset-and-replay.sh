#!/usr/bin/env bash
#
# One-shot reset for the mac-forwarder after the 2026-04-23
# hold-the-tail fix. Deletes truncated mac events + all reports
# from Supabase, clears the forwarder checkpoint, and reloads
# launchd so the fixed forwarder replays from AW-local history.
#
# See docs/session-2026-04-23-aw-forwarder.md for context. Does
# NOT re-trigger orchestrator cron jobs (daily-digest etc.) — that
# step is manual on Hetzner.
#
# Usage:
#   ./reset-and-replay.sh             # dry run: prints the plan
#   ./reset-and-replay.sh --execute   # actually applies (prompts y/n)
#
# Requires DATABASE_URL in env pointing at the service_role DSN
# (normally via your admin workflow / scripts/.env.admin).
#
set -euo pipefail

MODE=dry-run
if [[ "${1:-}" == "--execute" ]]; then
  MODE=execute
fi

CHECKPOINT="${SCROLLANTIR_CONFIG_DIR:-$HOME/.scrollantir}/checkpoint.json"
PLIST="$HOME/Library/LaunchAgents/com.scrollantir.forwarder.plist"
LABEL="com.scrollantir.forwarder"

section() { printf '\n── %s ──\n' "$*"; }
fail()    { echo "error: $*" >&2; exit 2; }

# ─── preconditions ────────────────────────────────────────────────

section "Preconditions"

# If DATABASE_URL isn't exported but the admin env file exists, pull
# from there. `source` alone doesn't export, so users who run
# `source scripts/.env.admin` in their shell won't propagate it to
# this subshell unless we auto-load.
if [[ -z "${DATABASE_URL:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ENV_ADMIN="$(cd "$SCRIPT_DIR/.." && pwd)/scripts/.env.admin"
  if [[ -f "$ENV_ADMIN" ]]; then
    printf '  loading DATABASE_URL from %s\n' "$ENV_ADMIN"
    set -a
    # shellcheck disable=SC1090
    source "$ENV_ADMIN"
    set +a
  fi
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  fail "DATABASE_URL not set. Expected service_role DSN in scripts/.env.admin or env."
fi

role=$(psql "$DATABASE_URL" -At -c "SELECT current_user" 2>/dev/null || true)
if [[ -z "$role" ]]; then
  fail "can't connect to Postgres with provided DATABASE_URL"
fi
printf '  connected as: %s\n' "$role"
if [[ "$role" != "service_role" && "$role" != postgres ]]; then
  fail "DATABASE_URL must be service_role (need DELETE privilege). got: $role"
fi

if ! curl -sSf http://localhost:5600/api/0/info >/dev/null 2>&1; then
  fail "can't reach ActivityWatch at localhost:5600. Is aw-qt running?"
fi
printf '  AW reachable at localhost:5600\n'

if [[ ! -f "$PLIST" ]]; then
  fail "plist not found at $PLIST. Run mac-forwarder/setup.sh first?"
fi
printf '  forwarder plist present: %s\n' "$PLIST"

# ─── current state ────────────────────────────────────────────────

section "Current state"
psql "$DATABASE_URL" -c "
  SELECT 'mac events (window/afk/zen.tab)' AS what,
         COUNT(*) FROM public.events
         WHERE device='mac' AND source IN ('system.window','system.afk','zen.tab')
  UNION ALL
  SELECT 'mac events (test.curl stray)',
         COUNT(*) FROM public.events WHERE source='test.curl'
  UNION ALL
  SELECT 'reports (not soft-deleted)',
         COUNT(*) FROM public.reports WHERE deleted_at IS NULL;
"

# ─── plan ─────────────────────────────────────────────────────────

section "Plan"
cat <<EOF
  1. launchctl unload $LABEL
  2. DELETE FROM public.events WHERE device='mac'
       AND source IN ('system.window','system.afk','zen.tab')
  3. DELETE FROM public.events WHERE source='test.curl'
  4. DELETE FROM public.reports
  5. rm $CHECKPOINT
  6. launchctl load $PLIST
  (manual step:  trigger orchestrator jobs on Hetzner to regenerate reports)
EOF

if [[ "$MODE" == "dry-run" ]]; then
  echo
  echo "dry run complete. re-run with --execute to apply."
  exit 0
fi

# ─── confirmation ─────────────────────────────────────────────────

section "Confirm"
echo "This is DESTRUCTIVE. Mac events + all reports will be deleted."
read -p "Type 'yes' to proceed: " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "aborted."
  exit 0
fi

# ─── execute ──────────────────────────────────────────────────────

section "Executing"

echo "  stopping forwarder..."
launchctl unload "$PLIST" 2>/dev/null || true

echo "  deleting mac events + stray test.curl..."
psql "$DATABASE_URL" -c "
  DELETE FROM public.events
  WHERE device='mac' AND source IN ('system.window','system.afk','zen.tab');
  DELETE FROM public.events WHERE source='test.curl';
"

echo "  deleting reports..."
psql "$DATABASE_URL" -c "DELETE FROM public.reports;"

echo "  clearing forwarder checkpoint..."
rm -f "$CHECKPOINT"

echo "  restarting forwarder..."
launchctl load "$PLIST"

# ─── verify ───────────────────────────────────────────────────────

section "After"
psql "$DATABASE_URL" -c "
  SELECT 'mac events (all sources)' AS what,
         COUNT(*) FROM public.events WHERE device='mac'
  UNION ALL
  SELECT 'reports (not soft-deleted)',
         COUNT(*) FROM public.reports WHERE deleted_at IS NULL;
"

# ─── next steps ───────────────────────────────────────────────────

section "Next steps"
cat <<'EOF'
  1. Wait ~5-10 minutes for the forwarder to replay AW history.
     Watch:  tail -f ~/Library/Logs/scrollantir-forwarder.log
     (path depends on your plist's StandardOutPath; adjust if different)

  2. After replay, re-run the 'Current state' query to confirm row
     counts roughly match AW-local (with a few fewer due to tails
     still being held).

  3. Regenerate orchestrator reports. On Hetzner, either:
       a. wait for the next scheduled cron tick (07:00 CT daily,
          Sun 09:00 CT weekly), or
       b. manually invoke the job files under /scrollantir/jobs/
          via `claude -p` on the orchestrator.
     Not automated by this script.
EOF
