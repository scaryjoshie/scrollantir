#!/usr/bin/env bash
# PID 1 under tini. Two modes:
#   cron-foreground (default)  populate volume + assemble crontab + `cron -f`
#   <job-name>                 run one job once and exit (smoke/manual)
set -euo pipefail

: "${AGENT_DATABASE_URL:?AGENT_DATABASE_URL is required}"

# Claude Code accepts auth via either of two env vars:
#   CLAUDE_CODE_OAUTH_TOKEN  — long-lived subscription token (`claude setup-token`)
#   ANTHROPIC_API_KEY        — raw API key from console.anthropic.com
# One must be set; if both are, OAuth takes precedence inside the CLI.
# Switching billing models is a one-var swap — no image rebuild.
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "need either CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY" >&2
  exit 1
fi

# Populate /scrollantir from versioned image contents on first boot
# (or when files are added in later image releases). --ignore-existing
# preserves user-edited prompts across redeploys.
rsync -a --ignore-existing /app/runtime/ /scrollantir/

# Mirror .claude/settings.json to /root/.claude/ as user-level settings.
# Belt-and-suspenders: if any future invocation of claude happens with a
# CWD that isn't /scrollantir, the user-level allowlist still applies.
install -d -m 700 /root/.claude
install -m 600 /app/runtime/.claude/settings.json /root/.claude/settings.json

# State dirs at tight perms (install -d creates missing + applies mode;
# chmod after enforces mode on dirs carried over from older images).
install -d -m 700 /scrollantir/logs /scrollantir/memory
chmod 700         /scrollantir/logs /scrollantir/memory

# Build ~/.pgpass so psql never prompts. DSN's user, password, and
# database may be percent-encoded and may contain ':' or '\', both of
# which need backslash-escaping in .pgpass.
python3 - <<'PY' > /root/.pgpass
import os, urllib.parse as p
u = p.urlparse(os.environ["AGENT_DATABASE_URL"])
def esc(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace(":", "\\:")
raw_db = p.unquote((u.path or "/postgres").lstrip("/") or "postgres")
print(":".join([
    esc(u.hostname or ""),
    str(u.port or 5432),
    esc(raw_db),
    esc(p.unquote(u.username or "")),
    esc(p.unquote(u.password or "")),
]))
PY
chmod 600 /root/.pgpass

# Render the runtime crontab. Cron parses KEY=VALUE lines at the top
# and applies them to every job — that's the only reliable way to get
# env into cron jobs. No CRON_TZ (Ubuntu's cron ignores it); container
# TZ set in Dockerfile handles that.
{
  printf 'SHELL=%s\n' /bin/bash
  printf 'PATH=%s\n'  /usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
  [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_CODE_OAUTH_TOKEN"
  [[ -n "${ANTHROPIC_API_KEY:-}"       ]] && printf 'ANTHROPIC_API_KEY=%s\n'       "$ANTHROPIC_API_KEY"
  printf 'AGENT_DATABASE_URL=%s\n' "$AGENT_DATABASE_URL"
  printf '\n'
  cat /etc/cron.d/scrollantir.template
} > /etc/cron.d/scrollantir
chmod 0600 /etc/cron.d/scrollantir

case "${1:-cron-foreground}" in
  cron-foreground)
    exec cron -f
    ;;
  daily-digest|weekly-report|classifier|smoke)
    exec /usr/local/bin/run-job.sh "$1"
    ;;
  *)
    echo "unknown command: $1" >&2
    echo "usage: $0 [cron-foreground|smoke|daily-digest|weekly-report|classifier]" >&2
    exit 2
    ;;
esac
