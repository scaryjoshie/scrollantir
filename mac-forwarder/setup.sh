#!/usr/bin/env bash
# One-shot setup for the scrollantir Mac forwarder (runtime/ stack).
#
#   - Stores the bearer token in the macOS login keychain under
#     service=scrollantir-local, account=mac (via `security`)
#   - Builds a Python venv alongside this script and installs requirements
#   - Renders the launchd plist with absolute paths + the ingest URL,
#     writes it to ~/Library/LaunchAgents/, and reloads launchd
#
# Safe to re-run: replaces the keychain entry, the plist, and reloads
# the agent.
#
# Note: there's no config.json anymore — the ingest base URL is baked
# into the launchd plist as EnvironmentVariables.SCROLLANTIR_INGEST_URL,
# and the token lives in the keychain.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
PLIST_TEMPLATE="$SCRIPT_DIR/com.scrollantir.forwarder.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.scrollantir.forwarder.plist"
LOG_DIR="$HOME/Library/Logs"

KEYCHAIN_SERVICE="scrollantir-local"
KEYCHAIN_ACCOUNT="mac"

say() { printf "\033[1;34m[setup]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[setup]\033[0m %s\n" "$*" >&2; exit 1; }

# ─── prompt for ingest base URL + token ───────────────────────────────────
# Expect the BASE URL of the runtime stack (no path, no /rpc/...) — e.g.
#   https://ingest.178-104-253-30.nip.io   (Hetzner)
#   http://localhost                       (local dev runtime/ compose stack)
#
# The forwarder appends `/rpc/accept_event` itself.
default_url="${SCROLLANTIR_INGEST_URL:-}"

if [[ -n "$default_url" ]]; then
    read -rp "Ingest base URL [$default_url]: " ingest_url
    ingest_url="${ingest_url:-$default_url}"
else
    read -rp "Ingest base URL (e.g. https://ingest.178-104-253-30.nip.io): " ingest_url
fi
[[ -z "$ingest_url" ]] && die "ingest URL is required"

# Strip trailing slash and any accidental /rpc/* path the user pasted.
ingest_url="${ingest_url%/}"
case "$ingest_url" in
    */rpc/accept_event) ingest_url="${ingest_url%/rpc/accept_event}" ;;
    */rpc) ingest_url="${ingest_url%/rpc}" ;;
esac

read -rsp "Bearer token (input hidden): " token
echo
[[ -z "$token" ]] && die "token is required"

# ─── store token in keychain ──────────────────────────────────────────────
# -U: update if already present. -s service, -a account, -w password.
security delete-generic-password \
    -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1 || true
security add-generic-password \
    -s "$KEYCHAIN_SERVICE" \
    -a "$KEYCHAIN_ACCOUNT" \
    -w "$token" \
    -T /usr/bin/security \
    -T "$(command -v python3)" \
    -U
say "stored token in login keychain ($KEYCHAIN_SERVICE / $KEYCHAIN_ACCOUNT)"

# ─── Python venv + deps ───────────────────────────────────────────────────
if [[ ! -d "$VENV_DIR" ]]; then
    say "creating venv at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
fi
# shellcheck source=/dev/null
source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r "$SCRIPT_DIR/requirements.txt"
deactivate
say "installed Python deps into $VENV_DIR"

# ─── render + install launchd plist ───────────────────────────────────────
mkdir -p "$(dirname "$PLIST_DST")"
mkdir -p "$LOG_DIR"

VENV_PY="$VENV_DIR/bin/python3"
FORWARDER="$SCRIPT_DIR/forwarder.py"

# Escape `&` and `|` in the URL so sed doesn't choke (URLs can hold
# query strings later). `|` is our delimiter, so escape it explicitly.
ingest_url_esc="${ingest_url//|/\\|}"

sed \
    -e "s|@@VENV_PY@@|$VENV_PY|g" \
    -e "s|@@FORWARDER@@|$FORWARDER|g" \
    -e "s|@@INGEST_URL@@|$ingest_url_esc|g" \
    -e "s|@@LOG_DIR@@|$LOG_DIR|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DST"
chmod 644 "$PLIST_DST"
say "installed plist at $PLIST_DST"

# Unload first if it was already loaded (ignore error) then load fresh.
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"
say "loaded com.scrollantir.forwarder"

say "done. tail logs with:  tail -f $LOG_DIR/scrollantir-forwarder.out.log"
