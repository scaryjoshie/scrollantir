-- Ensure pgcrypto is installed in the `extensions` schema (the
-- Supabase convention). The ingest_api.* functions call digest()
-- as `extensions.digest(...)` because their search_path doesn't
-- include `extensions` — so the extension has to actually live
-- there for those qualified calls to resolve.
--
-- This migration used to also carry a full `CREATE OR REPLACE
-- FUNCTION ingest_api.accept_event` with the function body of that
-- moment (rate limit 200/min, and a rate-counter-on-every-call
-- semantic we later decided was wrong). Re-running it in isolation
-- after later migrations would silently revert those fixes. Trimmed
-- on 2026-04-21 to just the extension install; subsequent
-- migrations own the function body.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
