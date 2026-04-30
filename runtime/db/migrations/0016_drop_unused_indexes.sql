-- migrate:up
--
-- Drop unused indexes flagged by the 2026-04-30 index audit.
--
-- `derived_events_start_desc` (start_ts DESC):
--   No deriver code or dashboard query orders by start_ts DESC against
--   derived_events. The 934 idx_scan reading came from psql `\d`
--   tooling, not the app. 184 kB of write overhead per insert paying
--   for nothing. Drop.
--
-- The other indexes audited (`derived_events_source_start`,
-- `derived_events_project_chunk_span`, `derived_events_pkey`) are
-- actively used and stay. The audit also recommended a NEW partial
-- index on (source, end_ts) for span-overlap queries — DEFERRED until
-- the lazy-fetch architecture (commit 34bd573) settles into typical
-- usage; the current `(source, start_ts)` index handles the new
-- time-window query path adequately (measured 0.18 ms).

BEGIN;

DROP INDEX IF EXISTS public.derived_events_start_desc;

COMMIT;


-- migrate:down
-- Restore the index. start_ts DESC was the original definition.
CREATE INDEX IF NOT EXISTS derived_events_start_desc
  ON public.derived_events (start_ts DESC);
