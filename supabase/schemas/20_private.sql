-- Private schema: sensitive things that must never be exposed
-- through the PostgREST API. The `private` schema is not listed in
-- api.schemas in config.toml, so these tables have no HTTP surface.
-- Only SECURITY DEFINER functions (and service_role) read them.

CREATE SCHEMA IF NOT EXISTS private;


-- ─────────────────────────────────────────────────────────────────
-- tokens: device credentials. One row per bearer ever minted.
-- token_hash is sha256(plaintext); plaintext never stored. The
-- admin CLI inserts here; ingest_api.accept_event reads it to
-- validate a presented bearer. Revocation is a one-row UPDATE.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE private.tokens (
  token_hash    TEXT PRIMARY KEY,
  token_prefix  TEXT NOT NULL,
  device_id     TEXT NOT NULL REFERENCES public.devices(device_id),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,

  CONSTRAINT tokens_hash_looks_like_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tokens_prefix_nonempty        CHECK (length(btrim(token_prefix)) > 0),
  CONSTRAINT tokens_prefix_length          CHECK (length(token_prefix) BETWEEN 4 AND 12)
);

CREATE INDEX tokens_device_id ON private.tokens (device_id);
CREATE INDEX tokens_active    ON private.tokens (token_hash) WHERE revoked_at IS NULL;

ALTER TABLE private.tokens ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────
-- ingest_rate_limit: per-token per-minute fixed-window counters.
-- ingest_api.accept_event upserts a row for each request and
-- rejects if the minute's count exceeds the limit.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE private.ingest_rate_limit (
  token_hash   TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (token_hash, window_start),
  CONSTRAINT rate_limit_hits_nonneg CHECK (hits >= 0)
);

-- Index for the window_start time lookup during cleanup.
CREATE INDEX ingest_rate_limit_window ON private.ingest_rate_limit (window_start);

ALTER TABLE private.ingest_rate_limit ENABLE ROW LEVEL SECURITY;
