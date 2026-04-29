# Session 2026-04-29 — `place_visit/v1` + `travel_leg/v1` shipped

Long session. The deriver runtime, two production derivers, the
agent_api write contract, the read-path views, the dashboard cutover,
and the live deployment all landed. `/today` now renders against real
GPS data, refreshing every 5 minutes.

Today's other thread (GPS noise filtering on the phone) is in
[session-2026-04-29-gps-noise.md](session-2026-04-29-gps-noise.md).
That's the upstream side; this doc is everything downstream (server-
side derivers + dashboard).

## TL;DR

- **Two derivers shipped**: `place_visit/v1` and `travel_leg/v1`. The
  /today page is no longer a fixture; it queries `derived_events` via
  two read-path views.
- **Auto-discovery via OSM**, not homegrown clustering. We use Mapbox
  Tilequery against `mapbox-streets-v8` to identify places by their
  named POIs. No HDBSCAN, no α-shapes — saves hundreds of lines and
  gives us better building names than we'd discover ourselves.
- **Live, rolling 5-minute tick** in the agent service. Each tick
  re-derives the last 24h via `agent_api.replace_derived_window` —
  idempotent, latency ≈ 5 min + the 8-min SPD dwell threshold = 13 min
  worst case from arriving at a new place to it appearing in /today.
- **Long-gap merge** collapses same-`place_id` visits across periods
  of no GPS (overnight indoor stays). Without this, the user appeared
  to "arrive at home at 3 PM" because the phone's GPS-attestation gate
  had silenced indoor readings overnight.
- **Many small bugs caught from running against real data** — three
  privilege gaps, a NULL `p_rows` window-clear, a duplicate-visit
  cross-window bug, a phantom "still" leg, a mismatched OSM-feature
  picker, a span-overlap fetch bug. All fixed; documented in commit
  messages.

## What's now live

### Schema

`public.places` got six additive columns and four new constraints
(migration 0001):
  - `osm_feature_type TEXT`, `osm_feature_id BIGINT` — OSM identity
    (natural key via `UNIQUE (osm_feature_type, osm_feature_id)`)
  - `centroid_lat`, `centroid_lng` — canonical coords from the
    matched OSM feature; `lat/lng` are kept as legacy shadow columns
    until v1 of the schema cleanup
  - `first_seen_ts`, `last_seen_ts` — deriver-maintained activity
    timestamps
  - CHECKs on centroid range and "OSM identity is all-or-nothing"

Two new schemas / artifacts:
  - `agent_api.replace_derived_window(p_source, p_start, p_end, p_rows)`
    — SECURITY DEFINER RPC, atomic delete-by-`start_ts`-in-window
    + insert. Validates `p_source` matches the deriver-source regex,
    rejects NULL `p_rows`, rejects rows whose source doesn't match
    `p_source` or whose `start_ts` falls outside `[p_start, p_end)`.
    Returns insert count.
  - `v_place_visit_today` and `v_travel_leg_today` — read-path views,
    `SELECT`able by `user_role` via PostgREST, return JSONB shapes
    matching the dashboard's `PlaceVisit` / `TravelLeg` types.

Six migrations applied to the live DB at Hetzner:
  - `0001_places_osm_columns.sql` — places amendments
  - `0002_agent_api_replace_derived_window.sql` — RPC + grants
  - `0003_today_views.sql` — read-path views
  - `0004_agent_role_places_writes.sql` — INSERT/UPDATE on places to
    `agent_role` (caught from real-data run; deriver upserts places)
  - `0005_agent_role_earthdistance.sql` — blanket EXECUTE on
    `public.*` functions to `agent_role` (the `places_geo` GiST
    index calls `ll_to_earth` on insert)
  - `0006_view_place_centroid.sql` — adds `centroid_lat`/`centroid_lng`
    to `v_place_visit_today.place` jsonb so the dashboard can probe
    the right building polygon for highlighting

### Python: deriver framework

`runtime/app/src/scrollantir/core/derivers/`:
  - `__init__.py` — `REGISTRY` dict + `register()` helper. Concrete
    derivers self-register at module import.
  - `base.py` — `Deriver` ABC, `DeterministicDeriver` (compute → rows
    → replace_derived_window), `LLMDeriver` (forward/complete scaffold
    for `sleep/v1` to slot in later).
  - `stay_points.py` — Stay-Point Detection (Zheng 2009 sliding
    window) + `merge_brief_exits` for bathroom-break tolerance + a
    `min_points` evidence guard that rejects 4-hour bridged-gap
    "stays" with only 2 readings on either side.
  - `place_visit.py` — the `place_visit/v1` deriver. SPD →
    brief-exit merge → OSM lookup → upsert place → emit visit row.
    Plus `_merge_same_place_long_gaps` (post-OSM, place_id-based,
    ≤12h gap) for the indoor-no-GPS bridging case.
  - `travel_leg.py` — fills gaps between consecutive visits with GPS
    path + activity-state-voted dominant_activity. Skips 'still'
    legs (phantom transit) and legs whose dominant_activity is
    unknown gets coerced to 'walking' (TS contract is non-null).

`runtime/app/src/scrollantir/core/`:
  - `db.py` — `connect_agent()` reads `DATABASE_URL` (or PG* envs).
  - `osm.py` — Mapbox Tilequery wrapper with in-process LRU cache.
    Categorizes features for the picker; the picker has a four-tier
    priority (building-class POI > typed-named non-mixed > any
    named non-landuse > closest fallback).
  - `places_repo.py` — `upsert_place(conn, feature)` → uuid, single
    `INSERT ... ON CONFLICT (osm_feature_type, osm_feature_id) DO
    UPDATE` for race-safety; manual name edits are preserved across
    re-derivation (the conflict update only touches centroid +
    last_seen_ts + category-via-COALESCE).

`runtime/app/src/scrollantir/agent/__main__.py`:
  - APScheduler ticking every 5 min; runs `place_visit/v1` then
    `travel_leg/v1` over the rolling last-24h window. First fire
    +10s after container start so reboots catch up immediately.
  - `tools/run_deriver.py` — CLI for ad-hoc per-window reruns and
    threshold tuning. `python -m scrollantir.tools.run_deriver list`
    + `... run --source X --start ISO --end ISO`.

### Tests

12 passing under `runtime/app/tests/`:
  - 7 SPD-level cases (Norris walking-still flips, 1s 120m spike,
    indoor 45m drift, sub-threshold dwell, thin-evidence
    bridge-gap rejected, three-point bridged-gap accepted,
    multi-stay separation)
  - 5 pipeline-level cases for the deriver (zero-places NULL fallback,
    two-buildings-distinct, OSM-503 doesn't abort, brief-exit merge,
    deterministic id stability)

### Dashboard

`/today` no longer reads from fixtures:
  - `dashboard/src/lib/api.ts` — `fetchPlaceVisits` and
    `fetchTravelLegs` call `v_place_visit_today` /
    `v_travel_leg_today` via PostgREST. Filter by **span overlap**
    (`start_ts < end_window AND end_ts > start_window`), not start_ts
    alone, so a visit spanning the day boundary surfaces on both
    days.
  - `dashboard/src/pages/Today.tsx` — `useQuery` for visits + legs;
    sorts into a `TimelineEntry[]` by start_ts; loading and error
    empty states; an in-progress-visit "currently here" indicator
    is deferred.
  - `dashboard/src/features/today/lookups.tsx` — React context the
    panes consume to look up visits/legs by id, replacing the prior
    fixture-import pattern.
  - **Building 3D highlight**: bumped from moderate purple to vivid
    `#E53935` red; queryRenderedFeatures probes the OSM POI's
    centroid (which sits inside the building polygon), not the
    visit's stay-centroid (which lands at the entrance, outside the
    polygon). Highlights are now reliable + obviously visible.

### Compose / deployment

`runtime/compose.yaml` — agent service got an `environment:` block:
  - `DATABASE_URL=postgres://agent_role:${AGENT_PW}@postgres:5432/...`
  - `MAPBOX_API_TOKEN=${MAPBOX_API_TOKEN:-}` — same `pk.*` token the
    dashboard uses via `VITE_MAPBOX_TOKEN`. Plumbed into
    `/opt/scrollantir/repo/runtime/.env` on Hetzner via a one-line
    pipe through `ssh + sudo tee` that never put the token in the
    agent's context.

Server doesn't have a `.git/`; `runtime/deploy.sh` is aspirational.
Deployments today are `rsync + sudo rsync into place + docker compose
build agent + docker compose up -d --no-deps agent`. We should make
deploy.sh actually work or document the rsync pattern; deferred.

## Design decisions, with reasoning

### No homegrown clustering

The four-agent research pass (problem-space, library survey,
algorithm survey, Codex) recommended SPD + HDBSCAN over stay-point
centroids. After looking at OSM data we realized Mapbox already has
Northwestern's buildings with names + categories; clustering would
just rediscover what's already mapped. The pivot cut the entire
discovery layer (HDBSCAN, α-shapes, polygon footprints, threshold
tuning) and replaced it with one Mapbox Tilequery call per stay-
point centroid.

### Visit IDs are deterministic

`uuid5(NAMESPACE_URL, "place_visit/v1:{start_ts_seconds_iso}:{lat:.5f},{lng:.5f}")`
— same visit re-derives to the same id. Travel legs reference visit
ids (`from_visit_id`/`to_visit_id`); without deterministic ids,
re-deriving visits would orphan all the leg refs.

### Lookback to prevent cross-window duplication

A visit started at T but extending into the rolling 24h window would
get a phantom new row anchored at the first in-window reading,
because `replace_window` deletes by `start_ts` — the original row's
start_ts is outside the window and stays. Fix: SPD reads readings
from `[start - 2*gap_threshold, end]`; stays whose start_ts is
before `start` are skipped on emit (an earlier run owns them).

### Long-gap merge keys on `place_id`, not centroid distance

If you spent 16h overnight at Willard but GPS only fired briefly at
03:09 outside, you'd see two short Willard visits separated by
hours. The post-OSM merge collapses consecutive visits with
identical, non-null `place_id` and a gap ≤12h. Centroid-distance
based merging could fold adjacent dorms together; place_id can't —
they have different OSM identities.

### `osm_match_radius_m = 50` (NOT 35)

I tried tightening to 35 once the phone-side GPS-attestation gate
landed and lost Kellogg Global Hub (its building POI was 36.5m from
the stay centroid). Reverted. Building POIs sit at the building
*centroid*, not its entrance; for typical campus buildings, the user
position is at a door 20-40m from the centroid. The 50m radius
accommodates building geometry, not GPS noise. Low-confidence
matches are flagged via `provenance.match_confidence`, not dropped.

### OSM picker priority

`_pick_best_feature` in osm.py walks features (already pre-sorted by
distance) into four buckets, returns the first non-empty:

  1. **Named building-class POI** — Mapbox tags building NAMES on
     a `poi_label` with `class='building'`. "Willard Residential
     College" beats "Fran's Cafe" (which is `class='food_and_drink'`)
     even when the cafe is closer, because the Mapbox renderer also
     prefers building labels over their tenants.
  2. **Named feature with non-`mixed` category** — typed POIs like
     `cls=education`/`cls=library`/`cls=food_and_drink` that map to
     real PlaceCategories.
  3. **Any named non-landuse feature** — last-resort name. Landuse
     polygons (e.g. campus boundary named "Northwestern University")
     are excluded entirely; they're too coarse to outrank a building.
  4. **Closest feature regardless** — guarantees every visit gets
     attributed to *something*.

### Phone-side filtering changes interact with deriver SPD

The phone-side session shipped a GPS-attestation gate, an accuracy
50m gate, and speed-based outlier rejection. That replaces my
deferred Hampel filter and tightens upstream noise. Net: cleaner
input → tighter centroids → fewer adjacent-building mismatches. But
indoor periods now have gaps instead of WiFi-jitter (the explicit
trade-off "honest gaps over plausible lies"). The long-gap merge is
the deriver-side accommodation for this trade.

## Knobs (current values; tune from data)

```
PlaceVisitV1Deriver:
  accuracy_max_m            30.0   (SPD reading filter)
  dist_threshold_m          40.0   (SPD anchor-extend bound)
  time_threshold_min        8.0    (min dwell to qualify as stay)
  gap_threshold_hours       4.0    (max time gap inside a stay)
  min_points                3      (min readings per stay — guards
                                    thin-evidence bridged gaps)
  brief_exit_max_gap_min    10.0   (post-SPD same-place merge)
  osm_match_radius_m        50     (Tilequery search radius)
  same_place_max_gap_hours  12.0   (post-OSM long-gap merge by place_id)

TravelLegV1Deriver:
  path_accuracy_max_m       50.0   (path inclusion filter)

agent/__main__.py:
  DERIVER_INTERVAL_MINUTES  5
  ROLLING_WINDOW_HOURS      24
```

## What's deferred / known gaps

- **`is_open` / "currently here" indicator** on the latest visit. The
  visit appears to "end" at the latest GPS reading even when the user
  is still there. Trivial to add (`data.is_open: bool` if `end_ts` is
  within the last gap_threshold), not done.
- **Confidence indicator UI** (⚠ on visits with `match_confidence <
  0.7` or `p95_accuracy_m > 30`). Soak first, tune threshold from
  real distribution.
- **`place_observations` table** — was in the plan, dropped after
  audit. Per-stay audit data lives in `provenance.source_event_ids`.
- **`v_active_mask` view** — independent; ships with /summary work.
- **`topic_chunk` rendering** — handoff doc said render-side; not yet
  built. Would let "you spent 1h on cmux at Tech" surface in the
  detail pane. The dashboard's `lookups.topicChunks` is wired and
  defaults to `[]` until this lands.
- **Per-visit name overrides** — building 275 (gym/parking-garage/
  Garage co-working stack) cannot currently differentiate context.
  Either topic_chunks or a `data.display_name_override` field will
  resolve.
- **Multiple-building highlight** — current implementation highlights
  only the selected visit's building. A "where I was today" overlay
  highlighting every visited building simultaneously is doable but
  not built.
- **Tier 2 indoor coverage** (`phone.location.coarse`, the relaxed
  WiFi-but-attested second tier the GPS-noise session contemplates).
  Not collected yet; deriver would extend `INPUTS` and add a
  per-source weight in SPD's centroid math.
- **`deploy.sh` doesn't actually work** — server has no `.git`. We
  rsync. Either fix the script or document the rsync flow.
- **Integration tests against a real Postgres** — the pipeline tests
  use mocked psycopg. Tests g (window-boundary) and h (late-arriving
  GPS replay) need pytest-postgresql or testcontainers; deferred.

## Building names — landed mapping & manual overrides applied

After running across a week's GPS, these places exist in `places`:

```
The Garage                                       building 275854338  (named POI 'general' / Coworking)
Willard Residential College                      poi_label 427024601 (renamed; Fran's Cafe POI was orphaned)
Northwestern University Technological Institute  poi_label various
Norris Center                                    poi_label various
North Campus Parking Garage                      poi_label various
Foster-Walker Complex                            poi_label various
Kellogg Global Hub                               poi_label various
```

Manual override: the `places.name` column is never overwritten by
the deriver after first INSERT (`ON CONFLICT DO UPDATE` SET clause
deliberately omits `name`). To rename a place:

```sql
UPDATE public.places SET name = '...' WHERE osm_feature_id = NNN;
```

Future visits matching that OSM feature retain the rename.

## Pointers

- [plan-place-visit-v1.md](plan-place-visit-v1.md) — the audited plan
  (now shipped; minor deviations noted in this doc)
- [handoff-derived-dashboard.md](handoff-derived-dashboard.md) —
  superseded by this session
- [session-2026-04-29-gps-noise.md](session-2026-04-29-gps-noise.md)
  — phone-side filtering, today's other work thread
- [`docs/data-model.md`](../data-model.md) — needs a small update to
  mark `place_visit/v1` and `travel_leg/v1` as shipped
- [`docs/concepts/places.md`](../concepts/places.md) — the OSM-backed
  identity model is new; needs a section
