# Places — named-location layer

Raw location events (`phone.location.reading`) are `(lat, lng, accuracy_m)` tuples. A **place** is a named, semantically-tagged region you care about: *Math 221*, *Home*, *Dining Hall*, *Office*. The dashboard joins raw location against places at query time to produce the human narrative.

## Status

✅ **Shipped 2026-04-29**. `place_visit/v1` and `travel_leg/v1`
derivers are live; the agent service runs them every 5 minutes
over a rolling 24h window. `/today` reads from the resulting
`derived_events` rows via two read-path views. See
[session-2026-04-29-place-visit.md](../sessions/session-2026-04-29-place-visit.md)
for the implementation chronicle.

The "as designed" prose below is preserved for context — much of it
is still accurate, but the implementation diverged from the original
plan in two big ways:

1. **No homegrown auto-discovery clustering** — Mapbox's existing
   POI data already names every Northwestern building. The
   `place_visit/v1` deriver matches each stay-point centroid to the
   nearest named OSM feature via Mapbox Tilequery; no DBSCAN, no
   α-shape polygons, no cluster-qualification thresholds. Saved
   hundreds of lines and gave us better names than we'd discover
   ourselves.
2. **Bathroom-break consolidation is two-tier**: a SPD-level
   brief-exit merge (10-min gap, 40m centroid distance) handles
   "step outside and back" cases; a post-OSM long-gap merge
   (≤12-hour gap, same `place_id`) handles overnight indoor periods
   where the phone's new GPS-attestation gate produces no readings.

## OSM-backed identity

The `places` table got six additive columns in migration 0001:

```sql
osm_feature_type TEXT,                  -- 'building' | 'poi_label' | 'landuse'
osm_feature_id   BIGINT,                -- Mapbox feature id (Streets v8 tileset)
centroid_lat     DOUBLE PRECISION,      -- OSM POI coords (canonical)
centroid_lng     DOUBLE PRECISION,
first_seen_ts    TIMESTAMPTZ,
last_seen_ts    TIMESTAMPTZ,
UNIQUE (osm_feature_type, osm_feature_id)
```

`(osm_feature_type, osm_feature_id)` is the natural key for
auto-discovered places. Hand-seeded places (none yet) leave both
NULL — the UNIQUE constraint allows multiple NULL pairs. Legacy
`lat/lng/radius_m` columns are kept as shadows of `centroid_lat/lng`
until v1 of the schema cleanup.

The `places.name` column is **never overwritten by the deriver after
first INSERT** — `places_repo.upsert_place` uses `INSERT ... ON
CONFLICT DO UPDATE` with `name` deliberately omitted from the SET
clause. This is the manual-override mechanism: rename a place via
SQL once and it sticks across every future deriver tick.

```sql
UPDATE public.places SET name = 'SPAC' WHERE osm_feature_id = 275854338;
```

## OSM picker priority (`runtime/app/src/scrollantir/core/osm.py`)

For each stay-point centroid, the deriver runs Mapbox Tilequery and
walks the returned features (pre-sorted by ascending distance) into
four priority buckets, returning the first non-empty:

1. **Named building-class POI** — `poi_label` features with
   `class='building'`. These ARE the building's name label
   (`Willard Residential College`, `Foster-Walker Complex`). Mapbox
   often tags the building polygon as anonymous and puts the name
   on a sibling poi_label. The Standard renderer prefers these
   labels for building-level rendering, and so do we.
2. **Named feature with non-`mixed` category** — typed POIs like
   `cls=education`, `cls=library`, `cls=food_and_drink`.
3. **Any named non-landuse feature** — landuse polygons (campus
   boundary "Northwestern University", parks) are excluded; they
   cover whole blocks and would outrank specific buildings.
4. **Closest feature regardless** — guarantees attribution.

Within a tier, the closest match wins (Tilequery returns features
pre-sorted by distance).

The default search radius is 50m. Tightening helped at first but
lost legitimate matches like Kellogg Global Hub at 36.5m;
`provenance.match_confidence = 1 - distance/radius` encodes
uncertainty better than a hard cutoff.

## Auto-discovery in practice

There's no separate "discovery" deriver. `place_visit/v1` does the
work: each stay-point that matches a new OSM feature triggers an
`upsert_place` that creates a `places` row with the matched name,
category (mapped from OSM tags), centroid, and `first_seen_ts`.
`last_seen_ts` updates on every subsequent visit.

Categories are inferred from Mapbox tags via lookup tables in
`osm.py`:

- `building.class=residential|apartments|house|dormitory` → `residence`
- `building.class=university|school|college` → `class`
- `poi_label.class=education|school|library` → `class` / `study`
- `poi_label.class=food_and_drink|restaurant|cafe` → `food`
- `poi_label.class=building` → looks at `type` field
  (`Dormitory`→`residence`, `Office`→`work`, `University`→`class`, ...)
- everything unknown → `mixed`

If the wrong category lands on a place, edit it in SQL — same
override semantics as `name`:

```sql
UPDATE public.places SET category = 'residence' WHERE osm_feature_id = NNN;
```

The deriver's upsert preserves a non-NULL existing category via
`COALESCE`.

## Visits + brief-exit / long-gap merge

After Stay-Point Detection produces stays, two merge passes run:

1. **`merge_brief_exits`** (in `stay_points.py`): collapse consecutive
   stays whose centroids are within 40m and gap is ≤10 min. The
   bathroom-break / coffee-run case. Bumps `brief_exit_count`.
2. **`_merge_same_place_long_gaps`** (in `place_visit.py`, post-OSM):
   collapse consecutive visits whose `place_id` is identical and
   non-null and whose gap is ≤12 hours. The overnight-indoor case.
   Place_id is the safe signal — adjacent buildings have different
   place_ids and won't fold together accidentally.

The original plan was a single category-keyed gap-tolerance table
(class:15min, residence:60min, food:5min). What we shipped is
simpler: one short-gap merge by centroid-distance + one long-gap
merge by place_id. Same outcome for the bathroom-and-back case;
better outcome for overnight stays.

## Schema

```sql
CREATE TABLE places (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,                    -- "Math 221", "Home", "Bartlett"
  category TEXT,                                 -- "class", "residence", "food", "study", "social", "work", "mixed"
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  radius_m REAL NOT NULL DEFAULT 50,             -- "at this place" tolerance
  schedule JSONB,                                -- see below
  metadata JSONB,                                -- arbitrary: class code, instructor, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (lat BETWEEN -90 AND 90),
  CHECK (lng BETWEEN -180 AND 180),
  CHECK (radius_m > 0)
);

CREATE INDEX places_category ON places (category);
CREATE INDEX places_geo      ON places USING gist (ll_to_earth(lat, lng));
```

Single-user: `user_id` is intentionally absent. If multi-user ever happens, it's an additive column with a backfill default.

### `schedule` JSONB shape

```json
{
  "days": ["Mon", "Wed", "Fri"],
  "start": "09:00",
  "end": "09:50",
  "timezone": "America/Chicago",
  "valid_from": "2026-01-15",
  "valid_until": "2026-05-01"
}
```

Optional. Absent for places without a recurring schedule (home, dining hall). Present for scheduled obligations (classes, recurring meetings, gym slots).

## Matching at query time

No OS-level geofencing. Every `phone.location.reading` event is joined against `places` at query time. **Use the two-stage bounding-box prefilter pattern** (see "Index-using radius queries" below) — `earth_distance(...) < p.radius_m` alone does NOT use the GiST index and seq-scans `places`:

```sql
-- Events tagged with the place they fall inside of (if any).
-- :max_radius_m is a constant ≥ MAX(p.radius_m); compute once or
-- inline (e.g. 200 if no place's radius exceeds 200 m).
SELECT
  e.start_ts,
  e.data->>'lat' AS lat,
  e.data->>'lng' AS lng,
  p.id   AS place_id,
  p.name AS place_name
FROM events e
LEFT JOIN places p
  ON earth_box(
       ll_to_earth((e.data->>'lat')::float, (e.data->>'lng')::float),
       :max_radius_m
     ) @> ll_to_earth(p.lat, p.lng)
 AND earth_distance(
       ll_to_earth((e.data->>'lat')::float, (e.data->>'lng')::float),
       ll_to_earth(p.lat, p.lng)
     ) < p.radius_m
WHERE e.source = 'phone.location.reading'
  AND e.start_ts > NOW() - INTERVAL '24 hours';
```

### Index-using radius queries

The `places_geo` GiST index built on `ll_to_earth(lat, lng)` only fires for the `earth_box(...) @> ll_to_earth(...)` operator. The natural-looking single-line query `earth_distance(...) < p.radius_m` does **not** use the index — Postgres seq-scans `places` for every reading.

Deriver convention: two-stage filter.

1. **Bounding-box prefilter** at the global maximum radius (`:max_radius_m`, a small constant — pre-compute as `SELECT MAX(radius_m) FROM places` once at deriver start, or inline). Index lookup; reduces candidates from N to a few.
2. **Exact `earth_distance` filter** against each candidate's per-place `radius_m`. Runs over the small candidate set, no index needed.

Skipping stage 1 will work correctly but scale linearly with `|places|` per reading. With a `place_visit/v1` cron tick processing thousands of readings, that becomes the bottleneck.

### Why query-time, not OS geofence

- **Schedule-awareness**: "at Math 221" is only meaningful Mon/Wed/Fri 9:00–9:50. Trivially a SQL predicate; impossible to encode in Android's GeofenceApi.
- **Unlimited places**: GeofenceApi caps at ~100 per app. Josh could easily accumulate more.
- **Revisable without redeploy**: rename, nudge radius, change schedule — all single SQL updates.
- **No Android-side state**: the app doesn't know about places at all, just emits raw readings.

### Radius tuning per category

- `class`: 30m — classrooms are specific, GPS noise inside a building is high, small radius forces more confident detection
- `residence`: 80m — dorms are bigger, and you often pass nearby on the way in
- `food`: 40m
- `study`: 50m
- `social`: 30m — friend's specific apartment, not the whole block
- `work`: 50m

Defaults. Override per place in the row.

## Visits + bathroom-break consolidation

A "visit" is a continuous period at a single place, derived from consecutive location readings matched to that place.

**Gap tolerance rule:**

> A visit to place `P` continues across a gap **if the user left `P`'s radius for less than `GAP_TOLERANCE_MIN` minutes AND returned to the same `P`**.

- `class`: 15 min (handles bathroom, quick conversation outside)
- `residence`: 60 min (grabbing food nearby)
- `food`: 5 min
- default: 10 min

Implementation: sliding window over matched-readings, collapse adjacent `P`-matches whose unmatched gap is under tolerance.

Rendered as:

```
📚 Math 221    09:02 – 09:50  (1 brief exit)
```

## Schedule-awareness: attendance derivation

```sql
-- "Did I attend Math 221 on each scheduled day this week?"
WITH scheduled AS (
  SELECT
    p.id AS place_id,
    p.name,
    generate_series(
      date_trunc('day', NOW() - INTERVAL '7 days'),
      NOW(),
      INTERVAL '1 day'
    ) AS day
  FROM places p
  WHERE p.schedule IS NOT NULL
),
expected AS (
  SELECT
    place_id, name, day,
    day + (schedule->>'start')::time AS expected_start,
    day + (schedule->>'end')::time AS expected_end
  FROM scheduled s
  JOIN places p USING (place_id)
  WHERE EXTRACT(DOW FROM day) IN (
    -- map day abbrev → DOW in the query
  )
),
visits AS (
  SELECT place_id, start_ts, end_ts FROM place_visits  -- view derived from matched events
)
SELECT
  e.name,
  e.expected_start,
  e.expected_end,
  v.start_ts IS NOT NULL AS attended,
  CASE WHEN v.start_ts IS NULL THEN 'skipped'
       WHEN v.start_ts > e.expected_start + INTERVAL '10 min' THEN 'late'
       ELSE 'on_time'
  END AS status
FROM expected e
LEFT JOIN visits v
  ON v.place_id = e.place_id
  AND v.start_ts < e.expected_end
  AND v.end_ts > e.expected_start
ORDER BY e.expected_start;
```

Output feeds an attendance view (see [views.md](../dashboard/views.md)).

## Chatbot-driven population

The natural interface for managing places is conversational. The agent in the architecture gets tools to read/write the `places` table.

### Example flow

> **You**: "I go to University of Chicago. This quarter: Math 221 Mon/Wed/Fri 9:00–9:50 at Eckhart, CS 221 Tue/Thu 10:30–12:00 at Crerar. I live at Snell-Hitchcock."

> **Agent**:
> 1. Looks up UChicago Eckhart Hall, Crerar, Snell-Hitchcock via Nominatim / Google Places API
> 2. Generates 3 `places` rows:
>    - `{name: "Math 221", category: "class", lat: 41.7921, lng: -87.6011, radius_m: 30, schedule: {days: ["Mon","Wed","Fri"], start: "09:00", end: "09:50", timezone: "America/Chicago"}}`
>    - `{name: "CS 221", category: "class", lat: 41.7906, lng: -87.6010, radius_m: 30, schedule: {days: ["Tue","Thu"], start: "10:30", end: "12:00", timezone: "America/Chicago"}}`
>    - `{name: "Home", category: "residence", lat: 41.7895, lng: -87.5989, radius_m: 80}`
> 3. Replies: "Added Math 221, CS 221, and Home. Want me to add common campus spots (Regenstein, Bartlett, the quad)?"

### Auto-discovery

The agent can periodically run:

```sql
-- Find stationary clusters the user hasn't named yet
SELECT
  round(lat::numeric, 4) AS lat,
  round(lng::numeric, 4) AS lng,
  COUNT(*) AS visits,
  SUM(duration_s) AS total_seconds
FROM unvisited_stationary_clusters
WHERE NOT EXISTS (SELECT 1 FROM places p WHERE ...)
GROUP BY round(lat, 4), round(lng, 4)
HAVING COUNT(DISTINCT date(timestamp_utc)) >= 5
   AND SUM(duration_s) > 7200
ORDER BY visits DESC;
```

And prompt: "You've spent 14 hours over 8 separate days at (41.787, -87.600). Want to name this place?"

Handles the "the gym Josh goes to but didn't tell the agent about" case.

## Relationship to the event pipeline

```
phone.location.reading  ────────┐
                                ▼
                        match against places
                                │
                                ▼
                        place_visits (derived view)
                                │
                        ┌───────┴────────┐
                        ▼                ▼
                  timeline view     attendance view
```

No changes to the collection layer. Places is purely interpretive.

## What doesn't belong here

- **Travel legs** between places are the complement of visits — derived from periods where no place matches + the preceding/following matched place. Lives in the same `place_visits` view, distinguished by `NULL` place_id.
- **In-place walking** (`activity.state = walking` during a visit) stays within the visit, annotated as sub-activity. Doesn't create a new visit.
- **GPS accuracy filtering** is done before the place match — drop readings with `accuracy_m > 200` so the match isn't noise-driven.
