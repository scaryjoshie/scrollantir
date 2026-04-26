#!/usr/bin/env bash
# Invoked by cron (env inherited from /etc/cron.d/scrollantir) or
# manually via `entrypoint.sh <job>`. Runs one job, logs, records a
# last-success marker for healthchecks.
set -euo pipefail

job="${1:?job name required}"
prompt="/scrollantir/jobs/${job}.md"
log="/scrollantir/logs/${job}-$(date -u +%Y%m%dT%H%M%SZ).log"
last="/scrollantir/memory/last-success-${job}"
trail="/scrollantir/memory/log.md"

install -d -m 700 /scrollantir/logs /scrollantir/memory

if [[ ! -f "$prompt" ]]; then
  echo "no prompt at $prompt" | tee -a "$log" >&2
  exit 2
fi

# Claude Code discovers project settings (.claude/settings.json) from
# CWD upward. Under cron CWD is /root, which misses /scrollantir/.claude.
# cd explicitly so both docker-exec and cron invocations see the same
# settings — the silent-no-op failure mode on 2026-04-21 traced to this.
cd /scrollantir

start_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '=== %s start %s ===\n' "$start_ts" "$job" >> "$log"

if claude -p "$(cat "$prompt")" --output-format text >> "$log" 2>&1; then
  date -u +%Y-%m-%dT%H:%M:%SZ > "$last"
  printf -- '- %s %s ok\n' "$start_ts" "$job" >> "$trail"
else
  rc=$?
  printf -- '- %s %s FAILED (rc=%d, see logs/%s)\n' \
    "$start_ts" "$job" "$rc" "$(basename "$log")" >> "$trail"
  exit "$rc"
fi
