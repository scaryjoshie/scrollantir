-- Tokens live in the `private` schema so they never appear in the
-- auto-generated PostgREST API surface. `config.toml` exposes only
-- `public` and `graphql_public`; `private` is unreachable over HTTP.
-- Edge functions use the service role which can read across schemas.

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE private.tokens (
  token_hash   TEXT PRIMARY KEY,                           -- sha256 of the bearer; plaintext never stored
  token_prefix TEXT NOT NULL,                              -- first 8 chars of plaintext for admin list readability
  device_label TEXT NOT NULL,                              -- 'mac' | 'pixel9' | 'dev'
  note         TEXT,                                       -- free-form annotation
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,

  CONSTRAINT tokens_hash_looks_like_sha256
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tokens_prefix_nonempty
    CHECK (length(btrim(token_prefix)) > 0),
  CONSTRAINT tokens_device_label_nonempty
    CHECK (length(btrim(device_label)) > 0)
);

CREATE INDEX tokens_device_label ON private.tokens (device_label);
CREATE INDEX tokens_active       ON private.tokens (token_hash) WHERE revoked_at IS NULL;

ALTER TABLE private.tokens ENABLE ROW LEVEL SECURITY;
