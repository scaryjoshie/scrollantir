"""OSM feature lookup via Mapbox Tilequery.

Used by `place_visit/v1` to map a stay-point centroid to the nearest
named building / POI / landuse feature in OSM. The OSM feature is the
place — we don't run our own clustering algorithm; OSM has Northwestern
mapped in detail and that's the source of truth.

API: `lookup_nearest_feature(lat, lng, radius_m=50) -> OSMFeature | None`.

Failure semantics — any HTTP error, timeout, 429, or no-feature-found
returns `None`. The deriver treats `None` as "no place attribution"
and emits the visit row with `place_id = NULL` rather than aborting.

Cache — in-process LRU keyed on rounded (lat, lng, radius). v0 is one
user running a backfill; an LRU is enough. Negative hits cache too
(repeated lookups in a basement that returned None don't re-fire the
network). Promote to a Postgres cache table only if the cache miss
rate during real backfill is high enough to bite Mapbox rate limits.

Token: server-side scope from `MAPBOX_API_TOKEN` env var. A Mapbox
public `pk.*` token works (Tilequery is public-token scoped) — the
same token the dashboard uses via `VITE_MAPBOX_TOKEN`.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Any

# httpx is the network client — used only when an actual lookup fires.
# Imported lazily so tests that monkey-patch `lookup_nearest_feature`
# don't need httpx installed on the host.
if TYPE_CHECKING:
    import httpx as _httpx_types  # noqa: F401

log = logging.getLogger("scrollantir.osm")

# Mapbox Streets v8 — the basemap tileset the dashboard's Standard style
# also reads from. Layers we care about for place identification:
#   - building     — named/typed building polygons
#   - poi_label    — POIs (cafes, libraries, etc.)
#   - landuse      — parks, parking, residential blocks
TILESET = "mapbox.mapbox-streets-v8"
LAYERS = ("building", "poi_label", "landuse")
TILEQUERY_BASE = f"https://api.mapbox.com/v4/{TILESET}/tilequery"

# How long a single Tilequery may take. Generous because backfills
# aren't latency-sensitive.
HTTP_TIMEOUT_S = 5.0

# Cache size. With cache keys rounded to ~11m, even a long backfill
# tends to hit a few hundred unique stay-point centroids; 4096 is
# plenty.
CACHE_SIZE = 4096


@dataclass(frozen=True)
class OSMFeature:
    """One Mapbox-tile feature picked as the best match for a centroid.

    `feature_type` is the Mapbox layer it came from
    (`'building'` | `'poi_label'` | `'landuse'`). `feature_id` is
    Mapbox's `id` for the feature — coupled to the tileset version.
    """

    feature_type: str
    feature_id: int
    name: str
    category: str  # one of: residence, class, food, study, social, work, mixed
    centroid_lat: float
    centroid_lng: float
    distance_m: float  # tilequery's reported distance from the query point
    raw_properties: dict[str, Any]


def lookup_nearest_feature(
    lat: float,
    lng: float,
    radius_m: int = 50,
) -> OSMFeature | None:
    """Find the closest OSM feature to (lat, lng) within `radius_m`.

    Returns `None` on:
      - no feature in radius
      - no Mapbox token configured
      - any HTTP error / timeout / 429
      - any malformed response

    The cache rounds lat/lng to ~11m before keying so adjacent stay
    points don't each re-query.
    """
    if not _token():
        log.warning("MAPBOX_API_TOKEN not set; skipping OSM lookup")
        return None
    rounded = (round(lat, 4), round(lng, 4), int(radius_m))
    return _lookup_cached(rounded)


@lru_cache(maxsize=CACHE_SIZE)
def _lookup_cached(rounded: tuple[float, float, int]) -> OSMFeature | None:
    import httpx  # lazy so tests don't need it installed

    lat, lng, radius_m = rounded
    try:
        response = httpx.get(
            f"{TILEQUERY_BASE}/{lng},{lat}.json",
            params={
                "radius": radius_m,
                "limit": 20,
                "layers": ",".join(LAYERS),
                "access_token": _token(),
            },
            timeout=HTTP_TIMEOUT_S,
        )
        response.raise_for_status()
        body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("OSM lookup failed at (%s, %s): %s", lat, lng, exc)
        return None

    features = body.get("features") or []
    if not features:
        return None

    # Tilequery returns features sorted by distance asc, but we re-rank
    # by category preference: a building beats a parking-lot landuse
    # polygon at the same distance. The picker walks features in order
    # and returns the first whose category we can confidently classify
    # as a building or POI.
    best = _pick_best_feature(features)
    if best is None:
        return None
    return _to_osm_feature(best)


def _is_building_poi(f: dict[str, Any]) -> bool:
    """A poi_label with class='building' is Mapbox's *building name*
    label — distinct from poi_labels for tenants of the building
    (e.g. 'Fran's Cafe' has class='food_and_drink'). The Standard
    renderer prefers these for building-level labeling, and so do
    we: the dorm beats the cafe inside it."""
    p = f.get("properties") or {}
    layer = p.get("tilequery", {}).get("layer", "")
    return layer == "poi_label" and p.get("class") == "building"


def _pick_best_feature(features: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Pick the best feature for visit attribution from a Tilequery
    response (features pre-sorted ascending by distance).

    Priority order, from highest to lowest. Within a tier, the
    closest match wins (the feature list comes sorted).

      1. Named building-label POI (`poi_label`, `class=building`).
         These are the labels the Mapbox renderer puts ON a building:
         "Willard Residential College", "Foster-Walker Complex".
         Outrank tenant POIs even when the tenant is closer — Fran's
         Cafe at 17m loses to Willard at 23m because the user is
         at the dorm, not specifically at the cafe.
      2. Named feature with a non-'mixed' category (a poi_label
         with class=education / library / food / etc., or a
         categorized building like Norris with class=university).
      3. Any named feature, even if category=mixed.
      4. Closest feature, named or not — last-resort fallback so a
         visit always lands SOMETHING.
    """
    building_pois: list[dict[str, Any]] = []
    typed_named: list[dict[str, Any]] = []
    any_named: list[dict[str, Any]] = []
    closest: dict[str, Any] | None = None
    for f in features:
        if not isinstance(f, dict):
            continue
        if closest is None:
            closest = f
        name = _name_from_feature(f)
        if not name:
            continue
        if _is_building_poi(f):
            building_pois.append(f)
        elif _category_from_feature(f) != "mixed":
            typed_named.append(f)
        else:
            any_named.append(f)
    if building_pois:
        return building_pois[0]
    if typed_named:
        return typed_named[0]
    if any_named:
        return any_named[0]
    return closest


def _to_osm_feature(f: dict[str, Any]) -> OSMFeature | None:
    props = f.get("properties") or {}
    geometry = f.get("geometry") or {}
    feature_id_raw = f.get("id")
    if feature_id_raw is None:
        return None
    # feature_id is sometimes int, sometimes a string of digits, occasionally
    # a non-numeric string (rare). Coerce to int when possible; otherwise
    # bail — silently mapping to 0 would collide all malformed features
    # under the same place_id.
    try:
        feature_id = int(feature_id_raw)
    except (TypeError, ValueError):
        log.debug("OSM feature id is non-numeric: %r — skipping", feature_id_raw)
        return None
    layer = props.get("tilequery", {}).get("layer") or ""
    distance_m = float(props.get("tilequery", {}).get("distance", 0.0))

    # Derive a centroid for the feature. Tilequery returns the geometry
    # of the matched tile feature; for a Polygon we'd compute centroid,
    # but for v0 we just take the first coord (good enough for visit
    # attribution; the dashboard re-renders against its own geometry).
    coords = geometry.get("coordinates")
    if isinstance(coords, list) and coords:
        first = coords
        # Walk down nested coord arrays until we hit a [lng, lat] pair.
        while isinstance(first, list) and first and isinstance(first[0], list):
            first = first[0]
        if isinstance(first, list) and len(first) >= 2:
            centroid_lng, centroid_lat = float(first[0]), float(first[1])
        else:
            return None
    else:
        return None

    return OSMFeature(
        feature_type=layer,
        feature_id=feature_id,
        name=_name_from_feature(f) or "",
        category=_category_from_feature(f),
        centroid_lat=centroid_lat,
        centroid_lng=centroid_lng,
        distance_m=distance_m,
        raw_properties=dict(props),
    )


# -----------------------------------------------------------------------------
# Feature → (name, category) heuristics
# -----------------------------------------------------------------------------

# Mapbox Streets v8 building.class values map roughly to OSM building=*.
_BUILDING_CATEGORY: dict[str, str] = {
    # residential
    "residential": "residence",
    "apartments": "residence",
    "house": "residence",
    "dormitory": "residence",
    # academic / class
    "university": "class",
    "school": "class",
    "college": "class",
    "kindergarten": "class",
    # work / commercial
    "office": "work",
    "commercial": "work",
    "industrial": "work",
    "retail": "work",
    # food
    "restaurant": "food",
    "cafe": "food",
    "fast_food": "food",
    # study
    "library": "study",
}

# poi_label.class / category values.
_POI_CATEGORY: dict[str, str] = {
    "food_and_drink": "food",
    "restaurant": "food",
    "cafe": "food",
    "fast_food": "food",
    "bar": "social",
    "pub": "social",
    "nightclub": "social",
    "education": "class",
    "school": "class",
    "college": "class",
    "library": "study",
    "study": "study",
    "lodging": "residence",
    "office": "work",
    "shopping": "work",  # closest non-leisure bucket
}

# landuse.class values that should be suppressed (we never want to call
# a "park" the user's home, etc., but we still emit it as a low-info
# 'mixed' attribution if nothing better is around).
_LANDUSE_CATEGORY: dict[str, str] = {
    "park": "mixed",
    "school": "class",
    "hospital": "mixed",
    "cemetery": "mixed",
    # parking — explicitly 'mixed' (not a place we want to highlight).
    "parking": "mixed",
}

# Building-label POIs (poi_label with class='building') carry the
# building type in the `type` field rather than `class`. Map common
# Mapbox values to scrollantir's PlaceCategory.
_BUILDING_POI_TYPE_CATEGORY: dict[str, str] = {
    "dormitory": "residence",
    "residential": "residence",
    "apartments": "residence",
    "house": "residence",
    "university": "class",
    "school": "class",
    "college": "class",
    "kindergarten": "class",
    "library": "study",
    "office": "work",
    "commercial": "work",
    "retail": "work",
    "industrial": "work",
    "warehouse": "work",
}


def _category_from_feature(f: dict[str, Any]) -> str:
    """Map a Mapbox feature to scrollantir's PlaceCategory.

    Categories are: `residence | class | food | study | social | work
    | mixed`. Falls through to `'mixed'` for unknowns.

    Building-label POIs (poi_label with class='building') get
    type-based mapping — Mapbox puts the building's actual type
    ('Dormitory', 'University', etc.) in the `type` field for these.
    """
    props = f.get("properties") or {}
    layer = props.get("tilequery", {}).get("layer") or ""
    cls = props.get("class") or ""

    if layer == "building":
        # Building polygons sometimes have class, sometimes only type.
        key = cls or props.get("type") or ""
        return _BUILDING_CATEGORY.get(key.lower(), "mixed")
    if layer == "poi_label":
        if cls == "building":
            typ = (props.get("type") or "").lower()
            return _BUILDING_POI_TYPE_CATEGORY.get(typ, "mixed")
        return _POI_CATEGORY.get(cls, "mixed")
    if layer == "landuse":
        return _LANDUSE_CATEGORY.get(cls, "mixed")
    return "mixed"


def _name_from_feature(f: dict[str, Any]) -> str:
    """Best-effort feature name. Mapbox tiles vary in which name field
    is populated; walk a few common fields and return the first hit."""
    props = f.get("properties") or {}
    for key in ("name", "name_en", "name_local", "ref"):
        v = props.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _token() -> str:
    return os.environ.get("MAPBOX_API_TOKEN", "").strip()


def clear_cache() -> None:
    """Clear the in-process LRU. Useful in tests + for manual reruns
    after rule changes."""
    _lookup_cached.cache_clear()
