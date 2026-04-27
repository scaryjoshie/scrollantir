#!/usr/bin/env bash
# scrollantir runtime — one-shot token mint for the local Postgres.
# Runs ON THE VM (or anywhere with `docker compose` access to the
# postgres container). Generates a 32-byte URL-safe token, inserts
# sha256(plaintext) into private.tokens, prints plaintext + the
# ingest URL. Reuses the existing compose project's postgres
# container — no extra deps.
#
# Usage:
#   ./mint-token.sh <device_id>           # → plaintext, prefix, URL
#
# Env (read from the compose project's runtime/.env):
#   POSTGRES_USER, POSTGRES_DB, INGEST_HOSTNAME (used to build URL)
#
# Run from /opt/scrollantir/repo/runtime/ (or pass --compose-dir).

set -euo pipefail

DEVICE_ID="${1:?usage: ./mint-token.sh <device_id>  (phone | mac | cloud | prompt)}"

case "$DEVICE_ID" in
  phone|mac|cloud|prompt) ;;
  *) echo "unknown device_id: $DEVICE_ID  (expected: phone | mac | cloud | prompt)" >&2; exit 2 ;;
esac

COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$COMPOSE_DIR"

if [[ ! -f .env ]]; then
  echo "no .env at $COMPOSE_DIR/.env" >&2
  exit 2
fi

# Source .env to pick up POSTGRES_USER / POSTGRES_DB / INGEST_HOSTNAME.
# shellcheck disable=SC1091
set -a; source ./.env; set +a
PGUSER="${POSTGRES_USER:-scrollantir}"
PGDB="${POSTGRES_DB:-scrollantir}"

# Generate plaintext + sha256(hex). The DB column is BYTEA; use
# decode(?, 'hex') in the INSERT.
PLAINTEXT="$(openssl rand -base64 32 | tr -d '=' | tr '+/' '-_')"
HASH_HEX="$(printf '%s' "$PLAINTEXT" | shasum -a 256 | awk '{print $1}')"
PREFIX="${PLAINTEXT:0:8}"

# Insert. Use docker compose exec so we don't need host postgres access.
DOCKER="docker"
if ! docker compose ps -q postgres >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi

$DOCKER compose exec -T postgres psql -U "$PGUSER" -d "$PGDB" <<EOF
INSERT INTO private.tokens (device_id, token_hash, prefix)
VALUES ('$DEVICE_ID', decode('$HASH_HEX', 'hex'), '$PREFIX');
EOF

# Build the ingest URL.
if [[ -n "${INGEST_HOSTNAME:-}" ]]; then
  URL="https://$INGEST_HOSTNAME"
else
  URL="http://localhost"
fi

echo
echo "Minted token for device '$DEVICE_ID'."
echo
echo "  Plaintext: $PLAINTEXT"
echo "  Prefix:    $PREFIX"
echo "  URL:       $URL"
echo
case "$DEVICE_ID" in
  mac)
    echo "Mac forwarder install:"
    echo "  security add-generic-password -s scrollantir-local -a mac -w '$PLAINTEXT'"
    echo "  Set SCROLLANTIR_INGEST_URL=$URL in the launchd plist env."
    ;;
  phone)
    echo "Phone:"
    echo "  Build the QR via ./admin local mint --device-id phone"
    echo "  (or paste URL + plaintext into the manual-onboarding fields)"
    ;;
esac
