# Places — named-location layer

Raw location events (`phone.location.reading`) are `(lat, lng, accuracy_m)` tuples. A **place** is a named, semantically-tagged region you care about: *Math 221*, *Home*, *Dining Hall*, *Office*. The dashboard joins raw location against places at query time to produce the human narrative.

## Status

🚧 Planned. Depends on:

1. [location.md](location.md) collection implemented first (need `phone.location.reading` events flowing)
2. Supabase schema extensions (see `supabase.md`)

## Schema

```sql
CREATE TABLE places (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,                       -- for future multi-user; Josh-only initially
  name TEXT NOT NULL,                           -- "Math 221", "Home", "Bartlett"
  category TEXT,                                -- "class", "residence", "food", "study", "social", "work"
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  radius_m REAL NOT NULL DEFAULT 50,            -- "at this place" tolerance
  schedule JSONB,                                -- see below
  metadata JSONB,                                -- arbitrary: class code, instructor, etc.
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE INDEX places_user_category ON places (user_id, category);
CREATE INDEX places_latlng ON places USING gist (
  ll_to_earth(lat, lng)                          -- earthdistance ext for radius queries
);
```

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

No OS-level geofencing. Every `phone.location.reading` event is joined against `places` at query time:

```sql
-- Events tagged with the place they fall inside of (if any)
SELECT
  e.timestamp_utc,
  e.data->>'lat' AS lat,
  e.data->>'lng' AS lng,
  p.id  AS place_id,
  p.name AS place_name
FROM events e
LEFT JOIN places p
  ON earth_distance(
       ll_to_earth((e.data->>'lat')::float, (e.data->>'lng')::float),
       ll_to_earth(p.lat, p.lng)
     ) < p.radius_m
WHERE e.source = 'phone.location.reading'
  AND e.timestamp_utc > NOW() - INTERVAL '24 hours';
```

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
    AND p.user_id = :user_id
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
