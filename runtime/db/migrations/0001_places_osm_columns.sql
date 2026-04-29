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

-- Centroid range checks. Match the schema CHECKs.
ALTER TABLE public.places
  ADD CONSTRAINT places_centroid_lat_range
    CHECK (centroid_lat IS NULL OR centroid_lat BETWEEN -90 AND 90)
    NOT VALID;
ALTER TABLE public.places
  ADD CONSTRAINT places_centroid_lng_range
    CHECK (centroid_lng IS NULL OR centroid_lng BETWEEN -180 AND 180)
    NOT VALID;
ALTER TABLE public.places VALIDATE CONSTRAINT places_centroid_lat_range;
ALTER TABLE public.places VALIDATE CONSTRAINT places_centroid_lng_range;

-- Partial OSM identity is an error: both fields go together.
ALTER TABLE public.places
  ADD CONSTRAINT places_osm_pair
    CHECK ((osm_feature_type IS NULL) = (osm_feature_id IS NULL))
    NOT VALID;
ALTER TABLE public.places VALIDATE CONSTRAINT places_osm_pair;

-- Natural key on the OSM identity. Multiple NULL pairs are allowed
-- (manual entries) since UNIQUE treats NULLs as distinct.
ALTER TABLE public.places
  ADD CONSTRAINT places_osm_feature_unique
    UNIQUE (osm_feature_type, osm_feature_id);

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
