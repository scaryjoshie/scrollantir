#!/usr/bin/env bash
# Source this (do not execute): `source scripts/load-dsn.sh`
# Pulls the user_role DSN from the macOS login keychain and exports it
# for the Vite dev-server API plugin. Browser never sees the DSN.

set -u

DSN="$(security find-generic-password -s scrollantir -a user-role -w 2>/dev/null || true)"

if [[ -z "${DSN}" ]]; then
  echo "error: keychain entry 'scrollantir/user-role' not found." >&2
  echo "hint:  run ./admin setup-roles from scripts/admin.py first." >&2
  return 1 2>/dev/null || exit 1
fi

export DATABASE_URL="${DSN}"
echo "DATABASE_URL loaded from keychain (user_role)."
