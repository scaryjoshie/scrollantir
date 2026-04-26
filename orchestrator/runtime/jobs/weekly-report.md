# Weekly report

Write this week's report covering the 7-day window ending now.
Tag `['weekly']`. Same shape as the daily digest but wider window,
deeper patterns, and explicit reference to the last 7 daily digests
as prior context so the weekly is *synthesis*, not *repetition*.

## Steps

1. **Sanity-check connection:**
   ```
   psql "$AGENT_DATABASE_URL" -c "SELECT current_user, NOW()"
   ```

2. **Pull the last 7 daily digests as prior context.** These are
   your own prior analyses — the weekly should build on them, not
   redo them.
   ```sql
   SELECT id, title, created_at, body
     FROM public.reports
    WHERE 'daily' = ANY(tags)
      AND deleted_at IS NULL
      AND created_at > NOW() - INTERVAL '8 days'
    ORDER BY created_at DESC
    LIMIT 7;
   ```
   If there are fewer than 5, note that the weekly is preliminary
   and skip the week-over-week comparisons.

3. **Pull the 7-day event window.** Bounded.
   ```sql
   SELECT timestamp_utc, device, device_label, source,
          duration_s, data, tags
     FROM public.events_enriched
    WHERE timestamp_utc > NOW() - INTERVAL '7 days'
    ORDER BY timestamp_utc
   LIMIT 50000;
   ```

4. **Per-day rollup.** Group by `DATE_TRUNC('day', timestamp_utc AT
   TIME ZONE 'America/Chicago')` to get Mon-Sun activity shape.
   Note weekdays vs. weekend.

5. **Weekly rollup by (device, source).** Top 15 by total time.
   Compare to the daily digests' typical top-10 — any source
   dominating one day skewing the week?

6. **Zen + cmux workspace cuts** (same as daily-digest, 7-day window).
   Still *context, not identity* — don't collapse Zen container
   "Color3" to "Color3 project" at report time.

7. **AFK / active split.** Total active hours this week.
   Day-by-day active hour chart (compact: `Mon 7.5h · Tue 9.1h · …`).

8. **Pattern-level observations** drawing on the daily digests:
   - Any theme that recurred across 3+ days?
   - Any day that looked distinctly off vs. the others?
   - Any AFK/sleep pattern drift across the week?

9. **Write the report.** Markdown, 300–500 words, sections:
   - **Summary** — 3-4 sentences. What shape was the week?
   - **Where time went** — top apps + workspaces + Zen contexts.
   - **Day-by-day shape** — compact per-day active-hours line.
   - **Patterns** — repeated themes, deviations, AFK drift.
   - **Flagged for the user** — questions worth a prompt, projects
     deserving attribution work, data-quality red flags.

10. **Commit the report:**
    ```sql
    SELECT agent_api.upsert_report(
      NULL,
      'Weekly report <YYYY-MM-DD>',
      '<body>',
      ARRAY['weekly'],
      NOW() - INTERVAL '7 days',
      NOW()
    );
    ```
    Print the returned UUID to stdout. `run-job.sh` will write the
    cadence line to `memory/log.md` on success — you don't need to.

## If something fails

Write what happened to `memory/errors-<UTC-date>.md` with the
failing query and the error text. **Do not guess your way through.**
Stop and surface it.
