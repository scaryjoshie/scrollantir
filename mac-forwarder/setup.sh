#!/usr/bin/env bash
# One-shot setup for the scrollantir Mac forwarder.
#
#   - Creates ~/.scrollantir/ and writes server URL into config.json
#   - Stores the bearer token in the macOS login keychain (via `security`,
#     no Python deps needed for this step)
#   - Builds a Python venv alongside this script and installs requirements
#   - Renders the launchd plist with absolute paths and loads it
#
# Safe to re-run: overwrites config, replaces plist, re-loads agent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.scrollantir"
CONFIG_PATH="$CONFIG_DIR/config.json"
VENV_DIR="$SCRIPT_DIR/.venv"
PLIST_TEMPLATE="$SCRIPT_DIR/com.scrollantir.forwarder.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.scrollantir.forwarder.plist"
LOG_DIR="$HOME/Library/Logs"

KEYRING_SERVICE="scrollantir"
KEYRING_ACCOUNT="ingest-token"

say() { printf "\033[1;34m[setup]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[setup]\033[0m %s\n" "$*" >&2; exit 1; }

# ─── prompt for server URL + token ────────────────────────────────────────
default_url="http://localhost:8069"
if [[ -f "$CONFIG_PATH" ]]; then
    existing_url=$(python3 -c "import json,sys; print(json.load(open('$CONFIG_PATH')).get('server_url',''))" 2>/dev/null || true)
    [[ -n "$existing_url" ]] && default_url="$existing_url"
fi

read -rp "Ingest server URL [$default_url]: " server_url
server_url="${server_url:-$default_url}"
[[ -z "$server_url" ]] && die "server_url is required"

read -rsp "Bearer token (input hidden): " token
echo
[[ -z "$token" ]] && die "token is required"

# ─── write config.json (no token) ─────────────────────────────────────────
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
cat > "$CONFIG_PATH" <<EOF
{
  "server_url": "$server_url"
}
EOF
chmod 600 "$CONFIG_PATH"
say "wrote $CONFIG_PATH"

# ─── store token in keychain ──────────────────────────────────────────────
# -U: update if already present. -s service, -a account, -w password.
security delete-generic-password \
    -s "$KEYRING_SERVICE" -a "$KEYRING_ACCOUNT" >/dev/null 2>&1 || true
security add-generic-password \
    -s "$KEYRING_SERVICE" \
    -a "$KEYRING_ACCOUNT" \
    -w "$token" \
    -T /usr/bin/security \
    -T "$(command -v python3)" \
    -U
say "stored token in login keychain ($KEYRING_SERVICE / $KEYRING_ACCOUNT)"

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

# Template uses @@VENV_PY@@ and @@FORWARDER@@ as placeholders. Replace with
# absolute paths. `sed` in-place with backup is portable on macOS.
VENV_PY="$VENV_DIR/bin/python3"
FORWARDER="$SCRIPT_DIR/forwarder.py"

sed \
    -e "s|@@VENV_PY@@|$VENV_PY|g" \
    -e "s|@@FORWARDER@@|$FORWARDER|g" \
    -e "s|@@LOG_DIR@@|$LOG_DIR|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DST"
chmod 644 "$PLIST_DST"
say "installed plist at $PLIST_DST"

# Unload first if it was already loaded (ignore error) then load fresh.
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load -w "$PLIST_DST"
say "loaded com.scrollantir.forwarder"

say "done. tail logs with:  tail -f $LOG_DIR/scrollantir-forwarder.out.log"
