-- The append-only stream from all forwarders. Every event — regardless of
-- source or device — has the same shape. Interpretation (tags) is
-- decoupled into `source_tags` so we can re-interpret history without
-- rewriting rows.

CREATE TABLE events (
  id             UUID PRIMARY KEY,                         -- client-generated, uuid5 on Mac, uuid4 on phone
  device         TEXT NOT NULL,                            -- 'mac' | 'phone' | ...
  source         TEXT NOT NULL,                            -- 'system.window' | 'youtube.shorts' | 'zen.tab' | ...
  timestamp_utc  TIMESTAMPTZ NOT NULL,                     -- event start; always UTC
  duration_s     DOUBLE PRECISION NOT NULL,                -- 0 for point events
  data           JSONB NOT NULL,                           -- source-specific payload; shape stable per source
  schema_version SMALLINT NOT NULL DEFAULT 1,              -- bump when a source's `data` shape changes
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),       -- server-side receive time

  CONSTRAINT events_duration_nonneg CHECK (duration_s >= 0),
  CONSTRAINT events_device_nonempty CHECK (length(btrim(device)) > 0),
  CONSTRAINT events_source_nonempty CHECK (length(btrim(source)) > 0)
);

-- Primary query path: "per-(device, source), by time."
CREATE INDEX events_device_source_time ON events (device, source, timestamp_utc);
-- Secondary: cross-source activity feed / debugging.
CREATE INDEX events_time_desc ON events (timestamp_utc DESC);

-- Default-deny. Edge functions use SERVICE_ROLE which bypasses RLS.
-- Dashboard SELECT policies land in a manual migration when the dashboard does.
ALTER TABLE events ENABLE ROW LEVEL SECURITY;


-- Cross-cutting categorizations. (device, source) is the natural scope
-- for a tag; the same source name on two devices may mean different
-- things (unlikely here but the arch doc's choice).
CREATE TABLE source_tags (
  device     TEXT NOT NULL,
  source     TEXT NOT NULL,
  tag        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (device, source, tag),
  CONSTRAINT source_tags_device_nonempty CHECK (length(btrim(device)) > 0),
  CONSTRAINT source_tags_source_nonempty CHECK (length(btrim(source)) > 0),
  CONSTRAINT source_tags_tag_nonempty    CHECK (length(btrim(tag))    > 0)
);

ALTER TABLE source_tags ENABLE ROW LEVEL SECURITY;
