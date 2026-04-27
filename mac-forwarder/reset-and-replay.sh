#!/usr/bin/env bash
#
# One-shot reset for the mac-forwarder. Deletes mac events + all reports
# from the runtime/ Postgres, clears the forwarder checkpoint, and
# reloads launchd so the forwarder replays from AW-local history.
#
# This is the runtime/ stack version. The earlier Supabase variant is
# gone (cutover commit `mac-forwarder: cutover to runtime/ stack`).
#
# Usage:
#   ./reset-and-replay.sh             # dry run: prints the plan
#   ./reset-and-replay.sh --execute   # actually applies (prompts y/n)
#
# Requires DATABASE_URL in env pointing at a role with DELETE on
# public.events + public.reports. The local runtime/ compose stack
# exposes one via the postgres superuser inside the postgres container;
# for Hetzner, supply the prod DSN.
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

if [[ -z "${DATABASE_URL:-}" ]]; then
  fail "DATABASE_URL not set. Point it at the runtime/ Postgres
       (local: see runtime/.env; remote: the Hetzner DSN)."
fi

role=$(psql "$DATABASE_URL" -At -c "SELECT current_user" 2>/dev/null || true)
if [[ -z "$role" ]]; then
  fail "can't connect to Postgres with provided DATABASE_URL"
fi
printf '  connected as: %s\n' "$role"

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
  SELECT 'mac events' AS what,
         COUNT(*) FROM public.events WHERE device='mac'
  UNION ALL
  SELECT 'reports (not soft-deleted)',
         COUNT(*) FROM public.reports WHERE deleted_at IS NULL;
"

# ─── plan ─────────────────────────────────────────────────────────

section "Plan"
cat <<EOF
  1. launchctl unload $LABEL
  2. DELETE FROM public.events WHERE device='mac'
  3. DELETE FROM public.reports
  4. rm $CHECKPOINT
  5. launchctl load $PLIST
  (manual step:  trigger agent jobs to regenerate reports)
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

echo "  deleting mac events..."
psql "$DATABASE_URL" -c "DELETE FROM public.events WHERE device='mac';"

echo "  deleting reports..."
psql "$DATABASE_URL" -c "DELETE FROM public.reports;"

echo "  clearing forwarder checkpoint..."
rm -f "$CHECKPOINT"

echo "  restarting forwarder..."
launchctl load "$PLIST"

# ─── verify ───────────────────────────────────────────────────────

section "After"
psql "$DATABASE_URL" -c "
  SELECT 'mac events' AS what,
         COUNT(*) FROM public.events WHERE device='mac'
  UNION ALL
  SELECT 'reports (not soft-deleted)',
         COUNT(*) FROM public.reports WHERE deleted_at IS NULL;
"

# ─── next steps ───────────────────────────────────────────────────

section "Next steps"
cat <<'EOF'
  1. Wait ~5-10 minutes for the forwarder to replay AW history.
     Watch:  tail -f ~/Library/Logs/scrollantir-forwarder.out.log

  2. After replay, re-run the 'Current state' query to confirm row
     counts roughly match AW-local (with a few fewer due to tails
     still being held).

  3. Regenerate reports via the runtime/ agent jobs (manual today;
     not automated by this script).
EOF
