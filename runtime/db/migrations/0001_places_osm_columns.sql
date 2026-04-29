-- migrate:up
-- Forward migration for an existing public.places table — adds the
-- OSM-backed identity columns introduced for place_visit/v1.
-- Apply against a live DB; fresh DB boots load these from
-- runtime/db/schemas/30_tables.sql directly and skip the migration.

ALTER TABLE public.places
  ADD COLUMN IF NOT EXISTS osm_feature_type TEXT,
  ADD COLUMN IF NOT EXISTS osm_feature_id   BIGINT,
  ADD COLUMN IF NOT EXISTS centroid_lat     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS centroid_lng     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS first_seen_ts    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_ts     TIMESTAMPTZ;

-- Idempotency: each constraint check guards against re-application
-- so this migration can re-run without erroring on a partially-
-- applied DB. Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so we
-- check pg_constraint manually.

-- Centroid range checks. Match the schema CHECKs.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'places_centroid_lat_range'
  ) THEN
    ALTER TABLE public.places
      ADD CONSTRAINT places_centroid_lat_range
        CHECK (centroid_lat IS NULL OR centroid_lat BETWEEN -90 AND 90)
        NOT VALID;
    ALTER TABLE public.places VALIDATE CONSTRAINT places_centroid_lat_range;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'places_centroid_lng_range'
  ) THEN
    ALTER TABLE public.places
      ADD CONSTRAINT places_centroid_lng_range
        CHECK (centroid_lng IS NULL OR centroid_lng BETWEEN -180 AND 180)
        NOT VALID;
    ALTER TABLE public.places VALIDATE CONSTRAINT places_centroid_lng_range;
  END IF;
END $$;

-- Partial OSM identity is an error: both fields go together.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'places_osm_pair'
  ) THEN
    ALTER TABLE public.places
      ADD CONSTRAINT places_osm_pair
        CHECK ((osm_feature_type IS NULL) = (osm_feature_id IS NULL))
        NOT VALID;
    ALTER TABLE public.places VALIDATE CONSTRAINT places_osm_pair;
  END IF;
END $$;

-- Natural key on the OSM identity. Multiple NULL pairs are allowed
-- (manual entries) since UNIQUE treats NULLs as distinct.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'places_osm_feature_unique'
  ) THEN
    ALTER TABLE public.places
      ADD CONSTRAINT places_osm_feature_unique
        UNIQUE (osm_feature_type, osm_feature_id);
  END IF;
END $$;

-- migrate:down
ALTER TABLE public.places DROP CONSTRAINT IF EXISTS places_osm_feature_unique;
ALTER TABLE public.places DROP CONSTRAINT IF EXISTS places_osm_pair;
ALTER TABLE public.places DROP CONSTRAINT IF EXISTS places_centroid_lng_range;
ALTER TABLE public.places DROP CONSTRAINT IF EXISTS places_centroid_lat_range;
ALTER TABLE public.places
  DROP COLUMN IF EXISTS last_seen_ts,
  DROP COLUMN IF EXISTS first_seen_ts,
  DROP COLUMN IF EXISTS centroid_lng,
  DROP COLUMN IF EXISTS centroid_lat,
  DROP COLUMN IF EXISTS osm_feature_id,
  DROP COLUMN IF EXISTS osm_feature_type;
