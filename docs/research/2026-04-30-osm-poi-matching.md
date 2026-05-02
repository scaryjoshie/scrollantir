# OSM/POI Matching: Mapbox Tilequery vs Alternatives

Date: 2026-04-30
Status: research complete
Author: research agent
Scope: investigate the "Unnamed university" Tech-building bug; decide whether
Scrollantir keeps Mapbox Tilequery, switches to a different geocoder, or
supplements with local building-polygon matching.

---

## 1. Verdict

**Supplement, don't switch.** Keep Mapbox Tilequery as the named-POI search
path — its free tier is generous for our scale (100K req/month free, we use
under 500/month at one user × ~14 visits/day × 30 days), it's already
integrated, and the Standard basemap the dashboard renders against is fed
from the same Mapbox Streets v8 tileset so the labels the user sees on the
map exactly match the labels we attribute. But the Tech-building bug isn't
a Mapbox quota or API problem — it's a **layer-design problem**: Mapbox's
`building` layer carries geometry only (`type`, `height`, `extrude`,
`underground`, `building_id`) and **does not carry the OSM `name` tag**
(confirmed in the Streets v8 reference). Names live in the separate
`poi_label` layer, where Tech is represented as a single POI POINT placed
at the building's "labelmark" — 65m southwest of where the user actually
is. Tilequery's `radius=50` filter eliminates the named POI, leaving only
the unnamed building polygon.

Switching to Nominatim/Photon/Overpass-as-API doesn't fix this; the
root cause is "we're matching points instead of polygons." The fix is to
load OSM **building polygons with names** for Evanston into a local
spatial index and prefer the polygon whose footprint *contains* the
centroid. We confirmed via direct Overpass query that Tech's polygon
(OSM way `35598594`) does carry `name=Northwestern University
Technological Institute` in raw OSM — so the data we need is there;
Mapbox just doesn't expose it through Tilequery.

Recommended stack: `osmnx` for the one-time extract (~5 lines of code),
`shapely` + `shapely.STRtree` for the spatial index (zero new deps —
shapely is on PyPI as a tiny C-backed wheel), one ~5-50MB pickle of
Evanston building footprints loaded at deriver init. Keep Mapbox
Tilequery as a secondary path for non-building POIs (parks, the cafe
inside Norris Center, etc.). Polygon match wins when the centroid is
inside a named polygon, otherwise fall through to Tilequery. Total new
code ~150-200 LOC, zero new subscription cost, fully offline-capable.

---

## 2. The Tech bug at the schema level

### Observed state in `places`

```
row 1: "Northwestern University Technological Institute"
       osm_feature_type=poi_label   class='building'   feature_id is the
       Mapbox poi_label feature id
       centroid=(42.05783, -87.67585)   ~65m SW of user

row 2: "building:35598594"             ← _fallback_name from places_repo.py:40
       osm_feature_type=building      (no name in Mapbox tile)
       centroid=(42.05820, -87.67530)   ~0m, user is inside polygon
```

User stay-centroid: `(42.0582, -87.6752)`.

### Why the picker grabbed the unnamed building

`runtime/app/src/scrollantir/core/osm.py:79` calls Tilequery with
`radius_m=50`. The named "Northwestern University Technological
Institute" `poi_label` feature sits ~65m SW of the stay-centroid (Tech
is a 200m+ wide H-shaped building; the POI POINT is at its labelmark
which is not where the user sits). Tilequery filters server-side by
`radius=50`, so the named POI is **never returned**. Of the features
Tilequery does return inside 50m, none carry a name field — both the
Tech building polygon and the `landuse=university` campus polygon are
unnamed in Mapbox tiles. `_pick_best_feature` (`osm.py:159`) walks its
tiers — no `class='building'` POI, no named non-landuse POI — and falls
through to "closest feature, named or not." The unnamed building
polygon at 0m wins. `_to_osm_feature` synthesizes a name as
`"building:35598594"` via `places_repo._fallback_name` (line 40), the
dashboard renders this; the category gets mapped from
`_BUILDING_CATEGORY` (`osm.py:261`), which has no entry for the missing
class, defaulting to `"mixed"`. (The user's report of "Unnamed
university" suggests a previous category-derivation path, but the
fallback name is the same regardless.)

### The data is there, Mapbox just doesn't expose it

Direct Overpass query around `(42.0582, -87.6752)` with a 100m radius
returns 6 building ways:

```
- way 35598594  Northwestern University Technological Institute
                                          short_name=Tech Institute
- way ...       Cook Hall
- way ...       Seeley G. Mudd Science and Engineering Library
- way ...       Frances Searle Building
- way ...       Sargent Hall
- way ...       (unnamed dormitory at 2247 Sheridan)
```

So the polygon we have stored as `building:35598594` is in raw OSM the
**same way id** with `name=Northwestern University Technological
Institute`. Mapbox Streets v8 strips the name when materializing the
`building` layer (the layer reference confirms `building` features carry
only `underground`, `type`, `height`, `min_height`, `extrude`,
`building_id` — no `name`).

The bug is therefore not a centroid problem, not a radius problem, not a
picker problem in isolation. It's a **layer architecture problem**: we
need polygon-with-name data, and Mapbox Tilequery doesn't return it.

### Why widening the radius doesn't help

Bumping `osm_match_radius_m` 50 → 80m would catch Tech's POI POINT, but
this regresses every case where the user is inside building B with
building A's POI POINT 60m away (e.g. user inside Mudd, Tech POI 70m
away across the lawn). The match radius is the wrong knob — distance to
labelmark is the wrong metric for big buildings. Tech, Kellogg Global
Hub, Foster-Walker, the football stadium are all 100m+ across.

### What "right" looks like

User is INSIDE Tech's polygon → the polygon's `name` tag answers the
question. We need the polygon geometry **and** its name locally.

---

## 3. Mapbox Tilequery audit

### Free tier headroom

- Free tier: **100,000 requests/month** (Mapbox pricing page).
- Beyond that: $1.50 per 1K (100K-500K), $1.20 per 1K (500K-1M),
  $0.90 per 1K (1M+).
- Endpoint rate limit: **600 requests/minute**, returns HTTP 429
  beyond that (Tilequery API docs).

Our usage: single user, ~7-14 visits/day per the task description.
Worst case 14 × 30 = 420 lookups/month before any cache hits. We're at
**~0.4% of the free tier**. Comfortable. Even if we 10x (multi-user
demo, dense backfill of years of history) we're still under 5%.

The `_lookup_cached` LRU (`osm.py:102`, size 4096, keys rounded to ~11m)
plus the `places` upsert mean a re-running backfill rarely re-hits the
network for the same centroid.

**Verdict: free tier is not the constraint.**

### Coverage of unnamed campus buildings (Mapbox tiles)

Mapbox Streets v8 `building` layer fields per the official reference:
`underground`, `type`, `building_id`, `height`, `min_height`, `extrude`.
**No `name` field.**

Names exist in `poi_label` layer (where the building name appears as a
separate POINT feature with `class='building'` and `type=<building
type>`). Per the reference, names live in label layers, not geometry
layers — by design.

Practical implication: every multi-tenant or large building on campus
where the name POI POINT > radius from the centroid will mismatch the
same way Tech does. Our `_is_building_poi` check (`osm.py:139`) is
exactly the right approach when the POI is in radius — but it can't
help when the POI is outside the radius.

### Self-hosting Mapbox tiles

Heavy. Mapbox's tilesets are proprietary derived data — their TOS
permits storing OSM-derived attribute data but not redistributing
Mapbox's own tiles. To self-host Streets-v8-equivalent data, you'd
build your own pipeline from a planet `.osm.pbf` extract using
something like `tilemaker` or `planetiler` (planet ~80GB compressed,
~2TB for full vector tiles). Out of scope for our needs.

### License — caching results

Mapbox API caching docs note Tilequery responses ship with
`Cache-Control: max-age=43200, s-maxage=300` — a hint, not a contract.
Specific caching restrictions live in each API's "Restrictions and
limits" section; the Tilequery page documents the rate limit (600/min)
but does not call out a TOS storage cap (we couldn't find a "30-day
TTL" requirement that some other Mapbox APIs have, e.g. Geocoding).

The OSM data underlying Tilequery is ODbL-licensed; OSM's licensing
permits indefinite caching with attribution. The risk surface is
specifically Mapbox-derived enrichment (their POI categorization,
their stylistic tagging). For a single-user app caching an
`osm_feature_type` + `osm_feature_id` + name + category, this is well
inside what their TOS contemplates as "Your derivative works of OSM
data." We are NOT redistributing Mapbox's vector tiles — we're
storing per-feature metadata for a single user's place attribution.

**Verdict: caching as we do is fine. The ODbL attribution requirement
("© OpenStreetMap contributors") should be visible in the dashboard
footer if it isn't already (a separate polish bug, file it).**

---

## 4. Direct OSM alternatives

### Nominatim (OSMF public API + self-host)

- API: `https://nominatim.openstreetmap.org/reverse?lat=…&lon=…&format=json`.
- Public usage policy: **max 1 req/sec, no bulk geocoding, attribution
  required, no auto-complete** (OSMF Nominatim policy). Single-user apps
  are explicitly OK if rate-limited and traffic is moderate.
- Returns: address-style results — `display_name`, `address` dict,
  `osm_id`, `osm_type`. **Does not return polygon geometry by default**
  (you'd need `polygon_geojson=1` and even then it returns the matched
  feature's polygon, not "all polygons containing this point").
- Polygon containment: not its primary mode. It picks "the most
  significant feature" at a point — for a campus point, often returns
  the campus landuse, not the building. For Northwestern's Tech, it
  would likely return either the building or the university grounds
  depending on `zoom` parameter.
- Self-host: Docker image exists; planet DB is large (~1TB on disk
  with full search index), but per-region (Illinois) is much smaller
  (~10s of GB). Heavy ETL.
- Python lib: `geopy.geocoders.Nominatim`, mature.

**Useful as a fallback geocoder. Not a polygon-matcher.**

### Overpass API (OSMF public + self-host)

- API: Overpass QL queries. For our use-case:
  ```
  [out:json][timeout:25];
  (
    way["building"](around:50, 42.0582, -87.6752);
    relation["building"](around:50, 42.0582, -87.6752);
  );
  out tags center;
  ```
- We **already used this in our investigation** to confirm the Tech
  polygon has the name tag — Overpass returned 6 buildings, 5 named.
- No formal rate limit but the public instance can be slow / time
  out under load. Heavy-use scenarios should self-host (Docker images
  exist; loading a state-level extract takes hours).
- Polygon containment: Overpass's `way["building"]` + `is_in` filter
  CAN do containment, but the public instance struggles with
  point-in-polygon at scale. Not its sweet spot.
- Python lib: `OSMPythonTools`, `overpy`, decent but the abstraction
  is "send a string query, parse JSON."

**Useful for one-time bulk extracts. Not great for live deriver-time
queries (latency, courtesy).**

### Photon (Komoot)

- Search-as-you-type geocoder, OSM-backed, public instance at
  `photon.komoot.io`. Their FAQ does not state a strict rate limit
  but discourages bulk use.
- Self-host: planet index is **~95GB on SSD, 64GB RAM recommended**
  (Photon GitHub README). Per-country smaller but still 5-20GB.
- Strength: forward search with autocomplete. Reverse geocode is
  supported but returns POINT features (POI labels), not polygon
  containment.
- Python lib: `photon` on CRAN (R-only); no canonical Python client,
  just `httpx`/`requests` + JSON.

**Optimized for forward search. Doesn't solve our polygon problem.**

### Local OSM extract + osmnx (THE ONE)

- Extract source: Geofabrik publishes Illinois `.osm.pbf` at **290 MB**
  (state-level). North America `.osm.pbf` is ~14 GB; we don't need
  that. For our use we'd actually go smaller: an Evanston bbox
  (`-87.71, 42.04, -87.66, 42.08`) yields tens of MB at most.
- `osmnx.features.features_from_bbox(bbox, tags={'building': True})`
  returns a `GeoDataFrame` with one row per building polygon, columns
  including `geometry` (shapely Polygon/MultiPolygon), `name`,
  `osmid`, `building` (the type tag), `addr:*`, etc.
- Update cadence: OSM updates daily; for our needs a quarterly or
  ad-hoc refresh is fine — campus buildings don't move.
- Python deps: `osmnx` (depends on `shapely`, `geopandas`,
  `networkx`, `requests`). At deriver runtime we don't need osmnx,
  just `shapely` to load a pickled list of `(name, category, polygon)`
  tuples and an `STRtree` for spatial query. osmnx is build-time only.

**This is the path. Section 5 lays out the integration.**

---

## 5. Building polygon matching path

### What polygon matching solves

| Symptom | Today | With polygon match |
|---|---|---|
| User inside named building, name POI > 50m | "building:NNNN" / Unnamed | Building's actual name |
| User inside unnamed building (real OSM unnamed) | "building:NNNN" | Still "Unnamed building" but at least we know the building's geometry, footprint, and `building=*` type — so we can render "Unnamed dormitory" honestly |
| Big complex disambiguation (which of two adjacent dorms?) | Closest POI POINT (often wrong) | The polygon containing the centroid (right by definition) |
| Visit attribution to landuse-only sites (parks) | Already works via Tilequery | Falls through to Tilequery (polygon path returns no match for non-building landuse) |

### Library choice

- **`shapely`** (^2.0): C-backed via GEOS, ~5MB wheel, on PyPI, zero
  hassle. Provides `Polygon.contains(Point)`, `Polygon.distance(Point)`,
  and the new `STRtree` (Sort-Tile-Recursive R-tree) for spatial
  indexing. Already a transitive dep of many GIS libs; if we ship a
  Docker image we add ~20MB.
- **`rtree`**: standalone R-tree backed by libspatialindex. We don't
  need it — `shapely.STRtree` (Shapely 2.x) provides the same
  functionality without a libspatialindex system dep.
- **`geopandas`**: nice-to-have for tabular wrangling, but at deriver
  runtime we just need a list of `(name, category, polygon)` tuples
  and a tree. We can skip geopandas entirely on the runtime path and
  keep it as a build-time tool.
- **`osmnx`**: build-time only. Used once to extract the Evanston
  building footprints to a pickle.

The performance caveat from the search: STRtree gives no speedup when
all bounding boxes are identical. That's not our case — campus
building bboxes are scattered. Expected query time per centroid:
sub-millisecond against a few thousand polygons.

### Coverage check

Direct Overpass for a 100m radius around the user's centroid returned
6 building ways with 5 named. Across the full Northwestern campus, the
named-building rate is high (Northwestern is one of the
better-mapped US campuses on OSM). For an Evanston-wide bbox, expect
on the order of a few thousand buildings, with the residential blocks
unnamed (which is fine — those resolve via address tags or fall
through to Tilequery).

### Update cadence

Once a quarter, manually:

```python
import osmnx as ox
import pickle

bbox = (-87.71, 42.04, -87.66, 42.08)  # Evanston-ish
gdf = ox.features.features_from_bbox(bbox, tags={'building': True})
gdf = gdf[gdf.geometry.type.isin(['Polygon', 'MultiPolygon'])]
records = [
    {
        'osmid': str(r.Index),
        'name': r.name if isinstance(r.name, str) else None,
        'building_type': getattr(r, 'building', None),
        'geom_wkb': r.geometry.wkb,
    }
    for r in gdf.itertuples()
]
with open('places_buildings.pkl', 'wb') as f:
    pickle.dump(records, f)
```

Resulting pickle: estimated 5-30MB. Ship it as a runtime resource (like
a config file). Refresh by re-running the script.

---

## 6. Concrete integration sketch

### Files

New: `runtime/app/src/scrollantir/core/osm_polygons.py`
- Loads the pickle once at import (or first call)
- Builds an `STRtree` of polygons
- Exposes `lookup_containing_building(lat, lng) -> BuildingMatch | None`

Modified: `runtime/app/src/scrollantir/core/osm.py`
- New entry point `lookup_place(lat, lng, radius_m=50)` that combines
  polygon path + Tilequery path
- Existing `lookup_nearest_feature` stays as-is (called by polygon
  path's fallback)

Modified: `runtime/app/src/scrollantir/core/derivers/place_visit.py`
- Calls the new `lookup_place` instead of `lookup_nearest_feature`.

### `osm_polygons.py` shape

```python
@dataclass(frozen=True)
class BuildingMatch:
    osmid: str                  # raw OSM way/relation id
    name: str                   # may be empty for unnamed buildings
    building_type: str          # raw OSM building=* tag
    centroid_lat: float
    centroid_lng: float
    contained: bool             # True if centroid is inside the polygon
    distance_m: float           # 0.0 if contained, else distance to polygon edge

def lookup_containing_building(lat, lng) -> BuildingMatch | None:
    # 1. Query STRtree for polygons whose bbox contains the point
    # 2. Filter to polygons that actually contain the point (shapely contains)
    # 3. If multiple, pick the smallest area (most specific = innermost)
    # 4. If none, optionally find nearest-polygon within ~30m (helps
    #    when GPS is on the wrong side of a wall)
    # 5. Return BuildingMatch or None
```

### Combined `lookup_place` policy

```
1. polygon_match = lookup_containing_building(lat, lng)
   - If contained AND has name: return as OSMFeature.
   - If contained AND no name: SAVE this as a candidate
     (gives us "Unnamed dormitory" rendering with the building polygon).
2. tilequery_match = lookup_nearest_feature(lat, lng, radius_m)
   - If returns a building-label POI (existing high-priority tier):
     compare with polygon candidate. If polygon contains AND has name,
     polygon wins (we're definitively inside it). Otherwise use the POI.
   - If returns a non-building POI (a cafe, park): use it — these are
     the cases where Tilequery is right (point of interest within a
     bigger building, e.g. a coffee shop inside a hotel).
3. Merge: prefer polygon-with-name when the centroid is inside;
   otherwise prefer the named POI within radius; otherwise return the
   unnamed polygon (rendered as "Unnamed <building_type>") rather than
   "building:NNN".
```

### Schema change: none required

The `places` table already keys on `(osm_feature_type, osm_feature_id)`
(`places_repo.py:9-10`). For a building-polygon match we already store
`osm_feature_type='building'` + the OSM way id; we just start populating
the `name` column with the real OSM name instead of falling back to
`building:NNN` (`places_repo._fallback_name` line 40). The Tech polygon
that's currently named `building:35598594` would become "Northwestern
University Technological Institute" — the same `places.id` row, just
re-named on next upsert.

The `metadata` JSON gains a `'osm_polygon'` key alongside the existing
`'mapbox'` key, so we keep provenance distinct.

### Tenet alignment

- **Tenet 1 (don't discard data):** rendering "Unnamed dormitory"
  using the polygon's `building=dormitory` tag is *more* truthful than
  hiding the visit as `place_id=NULL`. Polygon path strictly increases
  attribution coverage.
- **Tenet 7 (don't over-engineer for scale):** Evanston bbox → tens
  of MB pickle, single-process load, single user. Not a service, just
  a file read at deriver init.
- **Tenet 9 (keep the framework simple):** one new module
  (`osm_polygons.py`), one new entry point in `osm.py`, no new
  tables, no new derivers.
- **Tenet 4 (magic numbers cite data):** the "nearest-polygon within
  30m if not contained" knob needs a real-data citation before it
  ships — leave it OFF in the first cut, only turn it on when we see
  GPS-on-wrong-side-of-wall cases that justify it.

### Estimated effort

- One-time extract script: ~30 LOC.
- `osm_polygons.py` + tests: ~150 LOC.
- `osm.py` `lookup_place` wrapper + `place_visit.py` call site change:
  ~30 LOC.
- Total ~210 LOC + ~30MB resource file. Half a day.

### Risk: when polygon path is wrong

- User in a courtyard with a building polygon overlapping due to
  GPS error: STRtree's "smallest area wins" heuristic mostly handles
  this; courtyard not having a polygon means we fall through cleanly.
- Polygon stale vs. new construction: low for Northwestern, refresh
  the pickle quarterly.
- Polygon present but Mapbox POI more accurate (e.g. multi-tenant
  building where the POI is the specific floor): polygon path returns
  the building, Tilequery POI is the tenant. Today we already prefer
  building-label POIs over tenant POIs (`_is_building_poi`); the new
  policy continues that preference. The user is at the building,
  not the cafe inside it, by the existing tenet.

---

## 7. Sources

- [Mapbox Pricing — Tilequery free tier 100K/month, $1.50/1K beyond](https://www.mapbox.com/pricing) (confirmed 2026-04 via WebFetch)
- [Tilequery API docs — 600 req/min rate limit](https://docs.mapbox.com/api/maps/tilequery/)
- [Mapbox Streets v8 reference — `building` layer fields](https://docs.mapbox.com/data/tilesets/reference/mapbox-streets-v8/) (confirms no `name` field on building layer)
- [Mapbox API Caching guide](https://docs.mapbox.com/help/dive-deeper/api-caching/) (Tilequery default `Cache-Control: max-age=43200, s-maxage=300`)
- [OSMF Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/) (1 req/sec, single-user OK, no bulk)
- [Overpass API / Overpass QL wiki](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL)
- [Overpass `around` filter docs](https://dev.overpass-api.de/overpass-doc/en/full_data/polygon.html)
- [Geofabrik Illinois OSM extract — 290 MB pbf](https://download.geofabrik.de/north-america/us/illinois.html)
- [Photon GitHub README — ~95 GB planet index, 64 GB RAM](https://github.com/komoot/photon)
- [OSMnx documentation — features module](https://osmnx.readthedocs.io/en/stable/user-reference.html)
- [Shapely STRtree docs](https://shapely.readthedocs.io/en/stable/strtree.html)
- [Geoff Boeing — R-tree spatial indexing in Python](https://geoffboeing.com/2016/10/r-tree-spatial-index-python/)
- Direct Overpass query around `(42.0582, -87.6752)` on 2026-04-30 confirmed OSM way `35598594` carries `name=Northwestern University Technological Institute` + `short_name=Tech Institute`. This is the same way id Mapbox tiles surface as unnamed.
- Internal: `runtime/app/src/scrollantir/core/osm.py`, `places_repo.py`, `derivers/place_visit.py`, `docs/TENETS.md`.
