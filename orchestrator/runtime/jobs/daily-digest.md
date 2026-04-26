# Daily digest

Write today's daily digest covering the 24h window ending now.

## Steps

1. **Sanity-check connection:**
   ```
   psql "$AGENT_DATABASE_URL" -c "SELECT current_user, NOW()"
   ```

2. **Pull the window.** Use events_enriched so device label and tags
   come along for free. Keep it bounded.
   ```sql
   SELECT timestamp_utc, device, device_label, source,
          duration_s, data, tags
     FROM public.events_enriched
    WHERE timestamp_utc > NOW() - INTERVAL '24 hours'
    ORDER BY timestamp_utc
   LIMIT 10000;
   ```

3. **Roll up by (device, source).** Total seconds, event count,
   most-common titles/apps/containers where applicable. Top 10 by
   time.

4. **Zen tab detail (mac.zen.tab):** group by `data->>'container'`
   to get per-workspace time. Top 5 hosts by time as a separate
   cut. Remember: *container is context, not identity.* Report it
   as "time spent while Zen was focused on container X," not "time
   spent on project X."

5. **cmux workspace detail (system.window where app='cmux'):**
   time per `data->>'title'` (workspace name). Same framing as Zen
   containers — it's a context signal.

6. **AFK split:** hours afk vs. not-afk from system.afk. Use this
   to sanity-check total active time.

7. **Baseline comparison.** Read `memory/baselines.md` if it
   exists. If not, note that baselines need building and skip the
   comparison.

8. **Write the report.** Markdown, 150–300 words, sections:
   - **Summary** — 2-3 sentences. What shape was the day?
   - **Where time went** — top apps, top workspaces, top Zen hosts.
   - **Patterns / gaps** — long AFK spans, context-switch density,
     anything that stands out vs. baselines.
   - **Flagged for the user** — things worth asking about (each
     could become a prompt on the next run).

9. **Commit the report:**
   ```sql
   SELECT agent_api.upsert_report(
     NULL,
     'Daily digest <YYYY-MM-DD>',
     '<body>',
     ARRAY['daily'],
     NOW() - INTERVAL '24 hours',
     NOW()
   );
   ```
   Print the returned UUID to stdout so it's captured in the run
   log. `run-job.sh` will write the cadence line to `memory/log.md`
   on success — you don't need to.

## If something fails

Write what happened to `memory/errors-<UTC-date>.md` with the
failing query and the error text. **Do not guess your way through.**
Stop and surface it.
