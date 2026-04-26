# scrollantir orchestrator — always-on agent container
#
# Runs Claude Code CLI as a cron-invoked agent against Supabase. One
# container, one cron daemon, one persistent volume at /scrollantir.
# See docs/orchestrator.md for the full design.

FROM ubuntu:24.04

ENV TZ=America/Chicago \
    DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg tzdata rsync \
      postgresql-client cron \
      python3 nodejs npm tini \
    && ln -sf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo "$TZ" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI. npm package is the official path as of 2026-Q1; the
# native installer is a leaner alternative. Stick with npm unless the
# image size becomes a concern.
RUN npm install -g @anthropic-ai/claude-code \
    && claude --version

# Versioned runtime files live at /app/runtime in the image. At
# container start, entrypoint.sh rsyncs anything missing into
# /scrollantir (the mounted volume) — so image upgrades ship new files
# but user-edited prompts on the volume are preserved.
COPY runtime/             /app/runtime/
COPY entrypoint.sh        /usr/local/bin/entrypoint.sh
COPY run-job.sh           /usr/local/bin/run-job.sh
COPY crontab.template     /etc/cron.d/scrollantir.template
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/run-job.sh \
    && chmod 0644 /etc/cron.d/scrollantir.template

WORKDIR /scrollantir
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["cron-foreground"]
