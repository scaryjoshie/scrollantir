"""DB-side place lookup + upsert.

`upsert_place` is the bridge between an OSM feature (from `osm.py`) and
the `public.places` table. It guarantees a place row exists for the
feature, populating OSM ids, centroid, and category fields, and
returns the place's UUID.

Idempotent and concurrency-safe — implemented as a single
`INSERT ... ON CONFLICT (osm_feature_type, osm_feature_id) DO UPDATE`
so two callers racing on the same feature converge on one row without
the read-then-write hole that an UPDATE-then-INSERT pattern leaves.

The `places.name` UNIQUE constraint (`30_tables.sql:231`) is a
secondary collision risk: two different OSM features sharing a name.
On the rare occurrence we retry once with an OSM-suffixed name. The
OSM-keyed UNIQUE never reaches the retry path because it's resolved
inside `ON CONFLICT`.
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

import psycopg

from .osm import OSMFeature

log = logging.getLogger("scrollantir.places_repo")


def _fallback_name(feature: OSMFeature) -> str:
    """Stable name when the OSM feature has no `name` populated."""
    return f"{feature.feature_type}:{feature.feature_id}"


# Single atomic upsert. ON CONFLICT (osm_feature_type, osm_feature_id)
# resolves the OSM-key uniqueness; the legacy lat/lng shadow columns
# track centroid_lat/lng so derived-row consumers reading either field
# get the same answer. last_seen_ts always advances.
_UPSERT_SQL = """
    INSERT INTO public.places (
      name, category,
      lat, lng,
      centroid_lat, centroid_lng,
      osm_feature_type, osm_feature_id,
      first_seen_ts, last_seen_ts,
      metadata
    ) VALUES (
      %(name)s, %(category)s,
      %(centroid_lat)s, %(centroid_lng)s,
      %(centroid_lat)s, %(centroid_lng)s,
      %(osm_feature_type)s, %(osm_feature_id)s,
      NOW(), NOW(),
      %(metadata)s::jsonb
    )
    ON CONFLICT (osm_feature_type, osm_feature_id) DO UPDATE SET
      last_seen_ts = NOW(),
      centroid_lat = EXCLUDED.centroid_lat,
      centroid_lng = EXCLUDED.centroid_lng,
      lat          = EXCLUDED.centroid_lat,
      lng          = EXCLUDED.centroid_lng,
      -- Keep the user's hand-edited category if they set one — only
      -- backfill when category is currently NULL.
      category     = COALESCE(public.places.category, EXCLUDED.category)
    RETURNING id
"""


def upsert_place(
    conn: psycopg.Connection,
    feature: OSMFeature,
) -> UUID:
    """Get-or-create the `public.places` row for an OSM feature.

    Returns the place's UUID. Updates `last_seen_ts` and centroid
    coords on every call. Race-safe under concurrent callers — the
    OSM-key conflict is resolved inside the `ON CONFLICT` clause.

    Raises only if both the clean-name insert AND the name-suffixed
    retry hit the `places.name` UNIQUE constraint (very unlikely).
    """
    base_name = feature.name or _fallback_name(feature)
    metadata_json = json.dumps({"mapbox": feature.raw_properties})
    common = {
        "category": feature.category,
        "centroid_lat": feature.centroid_lat,
        "centroid_lng": feature.centroid_lng,
        "osm_feature_type": feature.feature_type,
        "osm_feature_id": feature.feature_id,
        "metadata": metadata_json,
    }

    # Try the clean name first; on places.name UNIQUE collision (rare —
    # two unrelated OSM features sharing a name), retry once with an
    # OSM-suffixed disambiguator. The OSM-keyed conflict is handled by
    # ON CONFLICT and never reaches this retry.
    for attempt, name in enumerate((base_name, f"{base_name} ({_fallback_name(feature)})")):
        try:
            with conn.cursor() as cur:
                cur.execute(_UPSERT_SQL, {**common, "name": name})
                row = cur.fetchone()
            conn.commit()
            if row is None:
                # ON CONFLICT DO UPDATE returns the row, so this should
                # never happen — defensive only.
                raise RuntimeError("upsert returned no row")
            return row[0]
        except psycopg.errors.UniqueViolation as exc:
            conn.rollback()
            # Distinguish the name collision (we can retry) from any
            # other unique violation (we can't — bail loudly).
            constraint = getattr(exc.diag, "constraint_name", "") or ""
            if constraint and "name" not in constraint.lower():
                log.warning(
                    "upsert_place: unexpected unique violation on %s: %s",
                    constraint,
                    exc,
                )
                raise
            if attempt == 0:
                log.info(
                    "upsert_place: name collision on %r; retrying with OSM suffix",
                    name,
                )
                continue
            log.warning(
                "upsert_place: name collision survived suffix retry for %s (%s)",
                feature.feature_type,
                feature.feature_id,
            )
            raise

    raise RuntimeError("unreachable")
