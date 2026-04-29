"""DB-side place lookup + upsert.

`upsert_place` is the bridge between an OSM feature (from `osm.py`) and
the `public.places` table. It guarantees a place row exists for the
feature, populating OSM ids, centroid, and category fields, and
returns the place's UUID.

Idempotent — re-running on the same feature stamps `last_seen_ts` but
otherwise leaves the row alone. Called from `place_visit/v1` once per
matched stay-point.

The `places.name` column has a pre-existing `UNIQUE` constraint
(`30_tables.sql:231`). Two distinct OSM features happening to share a
name is rare on a real campus but possible — we resolve by suffixing
the conflicting name with `(osm_type:osm_id)`.
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

import psycopg

from .osm import OSMFeature

log = logging.getLogger("scrollantir.places_repo")

# Name fallback when an OSM feature has no `name` populated. Includes
# the OSM ids so it's stable across reruns.
def _fallback_name(feature: OSMFeature) -> str:
    return f"{feature.feature_type}:{feature.feature_id}"


def upsert_place(
    conn: psycopg.Connection,
    feature: OSMFeature,
) -> UUID:
    """Get-or-create the `public.places` row for an OSM feature.

    Returns the place's UUID. Updates `last_seen_ts` (and centroid
    coords, in case OSM data shifted) on every call. Raises only if
    both the OSM-keyed insert AND the name-disambiguated retry fail.
    """
    # 1. Look up by OSM identity first — the natural key.
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE public.places
               SET last_seen_ts = NOW(),
                   centroid_lat = %s,
                   centroid_lng = %s
             WHERE osm_feature_type = %s
               AND osm_feature_id   = %s
            RETURNING id
            """,
            (
                feature.centroid_lat,
                feature.centroid_lng,
                feature.feature_type,
                feature.feature_id,
            ),
        )
        row = cur.fetchone()
        if row:
            conn.commit()
            return row[0]

    # 2. Insert. Try clean name first; on UniqueViolation (name
    #    collision), retry once with an OSM-suffixed name.
    base_name = feature.name or _fallback_name(feature)
    for attempt, name in enumerate((base_name, f"{base_name} ({_fallback_name(feature)})")):
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.places (
                      name, category,
                      lat, lng,
                      centroid_lat, centroid_lng,
                      osm_feature_type, osm_feature_id,
                      first_seen_ts, last_seen_ts,
                      metadata
                    ) VALUES (
                      %s, %s,
                      %s, %s,
                      %s, %s,
                      %s, %s,
                      NOW(), NOW(),
                      %s::jsonb
                    )
                    RETURNING id
                    """,
                    (
                        name,
                        feature.category,
                        # Legacy lat/lng shadow columns shadow the centroid
                        # for v0; drop in v1.
                        feature.centroid_lat,
                        feature.centroid_lng,
                        feature.centroid_lat,
                        feature.centroid_lng,
                        feature.feature_type,
                        feature.feature_id,
                        json.dumps({"mapbox": feature.raw_properties}),
                    ),
                )
                row = cur.fetchone()
                conn.commit()
                if row is None:
                    raise RuntimeError("insert returned no row")
                return row[0]
        except psycopg.errors.UniqueViolation as exc:
            conn.rollback()
            if attempt == 0:
                log.info(
                    "upsert_place: name collision on %r; retrying with OSM suffix",
                    name,
                )
                continue
            log.warning(
                "upsert_place: failed both attempts for %s (%s): %s",
                feature.feature_type,
                feature.feature_id,
                exc,
            )
            raise

    raise RuntimeError("unreachable")
