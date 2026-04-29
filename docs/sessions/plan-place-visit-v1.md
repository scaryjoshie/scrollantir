# Plan: `place_visit/v1` + `travel_leg/v1`

> **Date:** 2026-04-29 · **Status:** ✅ **SHIPPED 2026-04-29**. Both
> derivers, the agent_api RPC, the deriver framework, the read-path
> views, and the dashboard cutover all landed in this session.
> Implementation chronicle (with the deviations from this plan,
> bugs caught from running on real data, and current knob values)
> in
> [session-2026-04-29-place-visit.md](session-2026-04-29-place-visit.md).
> The plan body below is preserved as the source for design
> decisions, audit findings, and rationale.

Lands the first two derivers and swaps the /today dashboard from
fixtures to real data. Builds on the design discussion captured in
[handoff-derived-dashboard.md](handoff-derived-dashboard.md), a
four-agent research pass on GPS place detection (problem-space,
library survey, algorithm survey, Codex), and a two-agent audit of
the v1 plan (Plan + Codex). Audit-driven fixes are inline below;
see end-of-doc for the changelog.

## What we're building

Two derivers (plus schema, views, dashboard fetchers) that convert
the existing `phone.location.reading` stream into the day-narrative
entries the /today dashboard already consumes. After this ships,
`/today` renders against real data; the static fixture is retired.

## Design decisions locked in

1. **No homegrown clustering layer.** OSM building polygons replace
   HDBSCAN/α-shape discovery — places are OSM features we've
   stay-pointed inside. Mapbox already maps Northwestern in detail.
2. **Stay-Point Detection** (Zheng 2009, sliding window) is the
   segmentation primitive. Standard and well-trodden.
3. **Two SPD parameter tunes** carry the environment:
   - `accuracy_m > 30` → drop the reading
   - `gap_threshold` ≥ 2h so long indoor stays span no-GPS gaps
4. **No new "is this indoors?" logic.** Tightening `accuracy_m`
   implicitly throws away most indoor drift; the rest is handled by
   gap-bridging in SPD itself.
5. **Hysteresis state machine** for visit boundaries — enter on
   ≥2 consecutive in-place readings, exit only after ≥10 min outside
   or confirmed entry into a different place.
6. **Brief-exit tolerance**: re-entry to the same place within the
   grace period merges, increments `brief_exit_count`.
7. **Activity state does NOT drive visit boundaries.** It can
   annotate `travel_leg/v1` mode (walking/biking/in_vehicle) but
   visit boundaries are spatial-only. (Resolves the "walked around
   inside Norris" problem.)
8. **Centroid → nearest OSM feature within 50 m** for v0. Weighted
   voting deferred — start with the simplest match and only promote
   if real data shows wrong-building attribution.
9. **`provenance` carries audit metadata, `data` carries payload.**
   Per `30_tables.sql:97-106` the schema CHECK requires
   `provenance.{inputs, source_event_ids}`. Confidence-and-quality
   fields (`p95_accuracy_m`, `match_confidence`, GPS-reading IDs)
   live in `provenance`; user-facing fields (`place_id`, `lat`,
   `lng`, `brief_exit_count`) live in `data`. Keeps the data shape
   aligned with `data-model.md §4` and `dashboard/.../types.ts`.
10. **OSM via Mapbox Tilequery** at deriver time. **In-process
    cache only** for v0 (one user, single backfill run). Promote to
    a Postgres cache table or PostGIS + `osm2pgsql` if rate limits
    actually bite.
11. **Unrecognized stays still emit visits** with `place_id = NULL`
    and a reverse-geocoded fallback name. Bootstrap-friendly. If
    Mapbox is down/timing-out/429, the deriver still emits the
    visit with `place_id = NULL`; OSM lookup is decoupled from
    visit emission via separate `try` scopes.
12. **Deterministic visit IDs.** `derived_events.id` for visits is
    `uuid5(NAMESPACE_URL, "place_visit/v1:{start_ts_iso}:{centroid_geohash}")`.
    Re-deriving the same window produces the same IDs, so
    `travel_leg/v1` rows that reference visit IDs survive replays
    without dangling references. Mirrors the deterministic-id
    pattern raw events already use.
13. **`replace_window` is delete-by-`start_ts` in window** — per
    `data-model.md §4`. NOT span-overlap. Visits whose start_ts
    falls outside the window are untouched even if their span
    crosses the boundary. The plan does not add a GiST overlap
    index; a B-tree on `(source, start_ts)` is sufficient.
14. **Audit trail via `provenance.source_event_ids`** — no separate
    `place_observations` table. The information is the same; the
    schema CHECK already requires it.

## Commit-by-commit sequence

### Commit 1a — schema migration

- New migration in `runtime/db/migrations/`:
  - `places` amendments — *additive* against the existing table at
    `30_tables.sql:229-247` (which already has `name UNIQUE`,
    `schedule JSONB`, `metadata JSONB`):
    - ADD COLUMN `osm_feature_type TEXT`
    - ADD COLUMN `osm_feature_id BIGINT`
    - ADD COLUMN `centroid_lat DOUBLE PRECISION`
    - ADD COLUMN `centroid_lng DOUBLE PRECISION`
    - ADD COLUMN `first_seen_ts TIMESTAMPTZ`
    - ADD COLUMN `last_seen_ts TIMESTAMPTZ`
    - ADD CONSTRAINT `UNIQUE (osm_feature_type, osm_feature_id)`
    - Pre-existing `lat`/`lng`/`radius_m` retained — `radius_m`
      becomes the no-OSM fallback; `lat`/`lng` shadow `centroid_*`
      until we drop them in v1.
    - Pre-existing `schedule` and `metadata` are untouched —
      derivers don't write to them.
    - **Drop:** no `visit_count`/`total_dwell_s` columns. They're
      derived and would desync under replay; query them on demand.
    - **Drop:** no `footprint` JSONB. Deferred to v1.
  - B-tree index `derived_events (source, start_ts)` for the
    `replace_window` delete-by-start_ts pattern. No GiST overlap
    index in v0.
- **Drop:** `place_observations` table — `derived_events.provenance.
  source_event_ids` is the audit trail.
- **Drop:** `osm_lookup_cache` table — in-process cache for v0.

### Commit 1b — deriver framework + agent_api gate

- Decision: ship `agent_api.replace_derived_window` now (per
  `data-model.md §3` and `90_grants.sql` "writes go through
  agent_api"). Adding the RPC is ~30 LOC and avoids a documented
  contract violation; the alternative — granting `agent_role` direct
  INSERT/DELETE on `derived_events` and updating `90_grants.sql`
  — is also fine but mutates the security model for everyone.
- `runtime/db/schemas/60_agent_api.sql` (new): `agent_api.
  replace_derived_window(p_source TEXT, p_start TIMESTAMPTZ, p_end
  TIMESTAMPTZ, p_rows JSONB)` — DELETE rows where `source = p_source
  AND start_ts >= p_start AND start_ts < p_end`, then INSERT
  `p_rows`. Single transaction.
- `runtime/app/src/scrollantir/core/derivers/base.py` — `Deriver`
  ABC + `DeterministicDeriver` and `LLMDeriver` subclass scaffolds
  per `data-model.md §3`'s class hierarchy (only the deterministic
  path used in v0, but the LLM scaffold sets up `sleep/v1` cleanly).
- `runtime/app/src/scrollantir/core/derivers/__init__.py` — registry
  (a Python dict; not a DB table).
- **Drop:** APScheduler wiring stub. The scheduler already runs
  via `agent/__main__.py`; add the cron line in commit 4 when there
  is something to schedule.

### Commit 2 — OSM lookup helper

- `runtime/app/src/scrollantir/core/osm.py`:
  - `lookup_nearest_feature(lat, lng, radius_m=50) -> OSMFeature | None`
    using Mapbox Tilequery filtered to building + amenity + leisure
  - **In-process LRU cache** keyed by rounded geohash (precision 8 ≈
    19m) + radius — coarse-key avoids near-identical centroids each
    re-querying. Negative-hit caching with short TTL.
  - **Failure semantics**: any HTTP error/timeout/429 returns `None`;
    deriver treats this as "no OSM match," not "abort run." Lookup
    is in a separate `try` scope from visit emission.
  - Server-side Mapbox token via `MAPBOX_API_TOKEN` env var (separate
    from dashboard's `VITE_MAPBOX_TOKEN`).
  - Tag → `category` mapping:
    `building=residential|apartments|house|dormitory` → 'residence',
    `building=university|school|college` → 'class',
    `amenity=cafe|restaurant|fast_food` → 'food',
    `amenity=library|study` → 'study',
    `amenity=bar|pub|nightclub` → 'social',
    `building=office|commercial` → 'work',
    else → 'mixed'
- `upsert_place(osm_feature)` ensures a `places` row exists for the
  matched feature, populating OSM ids, name, category, centroid, and
  `first_seen_ts`/`last_seen_ts`.

### Commit 3 — pytest scaffolding + Stay-Point Detection + tests

- **Pytest scaffolding mini-prelude**: `runtime/app/tests/` dir,
  `pytest` extras in `pyproject.toml`, `pytest.ini` config, fixture
  helpers for synthetic GPS streams. Runtime project has no `tests/`
  today.
- `runtime/app/src/scrollantir/core/derivers/stay_points.py`:
  - `extract_stay_points(events, accuracy_max_m=30, dist_threshold_m=40,
    time_threshold_min=8, gap_threshold_hours=4) -> list[StayPoint]`
  - Accuracy prefilter, weighted centroid (by `1/accuracy_m`),
    gap-bridging when both bracketing readings are within
    `dist_threshold_m`. **No Hampel speed-spike filter in v0** —
    accuracy filter alone usually suffices; promote if real data
    shows residual spikes.
- `runtime/app/tests/test_stay_points.py` — synthetic-GPS fixtures
  for the SPD-level tests (a/b/c below); the place_visit-level tests
  (d/e/f) move to commit 4 since they need the full pipeline:
  - **a.** Norris walking-still flips → one stay, no split
  - **b.** One-second 120 m spike → filtered, no extra stay emitted
  - **c.** Indoor drift 45 m around Sargent → centroid stable, no
    oscillation
- These pass *before* commit 4 starts.

### Commit 4 — `place_visit/v1` deriver + per-window CLI

- `runtime/app/src/scrollantir/core/derivers/place_visit.py`:
  - Run SPD over the deriver's input window
  - For each stay-point: pick the OSM feature whose nearest distance
    from the stay's weighted centroid is ≤ 50 m (no voting in v0)
  - Hysteresis state machine emits visit spans
  - Deterministic `id = uuid5(NAMESPACE_URL, "place_visit/v1:
    {start_ts_iso}:{centroid_geohash}")` — survives replays so legs
    don't dangle
  - Row shape:
    - `data: {place_id, lat, lng, brief_exit_count}` — matches
      `dashboard/.../types.ts`
    - `provenance: {inputs: ['phone.location.reading'],
      source_event_ids: [...], p95_accuracy_m, match_confidence,
      stay_centroid: {lat, lng}, stay_dwell_s}`
  - Per-run metrics emitted (log + return value): readings dropped
    by accuracy filter, stays detected, visits with `place_id =
    NULL`, p95 of `match_confidence` distribution, OSM lookup
    errors. Lets us judge runs without eyeballing rows.
  - Idempotent — re-running on the same window produces identical
    output (deterministic ids + replace_window).
- `runtime/app/bin/run_deriver.py place_visit --window=2026-04-29`
  for ad-hoc reruns + threshold tuning. Per-window single-run is
  the actual debug tool; full backfill comes later.
- Tests added: edge cases d/e/f from the prior list, plus the
  audit-added cases:
  - **d.** First week, zero places → `place_id = NULL`, no false names
  - **e.** Two buildings 80 m apart on distinct schedules → separate
  - **f.** 45 s drive-by at a known place → no visit emitted
  - **g.** Visit spanning a window boundary → no duplicate, no split
    on re-derivation
  - **h.** Late-arriving GPS inside an already-derived window →
    correct replay
  - **i.** Mapbox lookup returns 429/timeout → visit emitted with
    `place_id = NULL`, no abort
  - **j.** Tied OSM matches → deterministic tie-break (e.g. lower
    OSM id wins) or `place_id = NULL` if `match_confidence` < 0.6

### Commit 5 — `v_active_mask` view (parallel ship)

Pulled out of commit 6 since it's independent of place/travel
derivers and useful elsewhere (the eventual /summary page also wants
this). Lands the only view that needs nothing else shipped first.

- New migration with `v_active_mask`: `mac.system.afk` "not afk"
  spans `∪` `phone.system.unlocked` spans, collapsed to
  non-overlapping intervals via `range_agg`.
- Grants: PostgREST anon role gets SELECT (PostgREST reads as
  `user_role`, not anon — confirm in the actual grants file when
  writing).

### Commit 6 — `travel_leg/v1` deriver

- `runtime/app/src/scrollantir/core/derivers/travel_leg.py`:
  - Fill gaps between consecutive `place_visit/v1` rows
  - `dominant_activity` voted from `phone.activity.state` events
    overlapping the leg
  - `path` inlined into `data` as ordered `[lng, lat]` array of
    leg-window `phone.location.reading` events filtered to
    `accuracy_m ≤ 50` (matches `types.ts:51-65`)
  - `data: {from_visit_id, to_visit_id, dominant_activity,
    distance_m, reading_count, path}` — single self-contained row,
    no separate path view needed
  - Deterministic `id = uuid5(NAMESPACE_URL, "travel_leg/v1:
    {from_visit_id}:{to_visit_id}")`
- **Atomic replay with visits**: when `place_visit/v1` re-derives a
  window, the corresponding `travel_leg/v1` window re-derives in
  the same transaction. The CLI in commit 4 takes a `--with-legs`
  flag that runs both.

### Commit 7 — `place_visit_today` + `travel_leg_today` views

- New migration with the place/leg read-path views:
  - `v_place_visit_today` — derived rows pre-joined with `places`
  - `v_travel_leg_today` — derived rows joined with from/to visits;
    `path` already inlined in `data`
- **Drop:** `v_travel_leg_path`. Not needed since path is inline.
- Grants update.

### Commit 8 — dashboard fetchers + fixture retirement

- `dashboard/src/lib/api.ts` — `fetchPlaceVisits(fromIso, toIso)`,
  `fetchTravelLegs(fromIso, toIso)`
- `dashboard/src/pages/Today.tsx` — swap `timelineEntries` fixture
  for fetched data; topic chunks remain render-side per handoff
- "Most recent visit may be incomplete" affordance: the latest
  visit in the day gets a small "live" indicator if `end_ts` is
  within the last `gap_threshold_hours` window — avoids confusing
  in-progress visits with finished ones.
- **Drop:** confidence indicator UI. Defer to commit 10 (post-soak)
  — UX polish for a deriver that hasn't run on real data yet.

### Commit 9 — backfill + verification

- `runtime/app/bin/run_deriver.py --backfill --from=YYYY-MM-DD`
  (dry-run flag prints what would be replaced without writing).
- Run on first day; eyeball; tune knobs; commit fixups.
- Then full backfill.

### Commit 10 — confidence indicator UI (post-soak)

- Small ⚠ on visits with `match_confidence < 0.7` or
  `p95_accuracy_m > 30`. Deferred from commit 8 because we want to
  see the actual distribution of those values before tuning the
  threshold.

## Edge-case test suite

SPD-level (commit 3, before commit 4 starts):

- **a.** Norris walking-still flips → one stay, no split
- **b.** One-second 120 m spike → filtered, no extra stay
- **c.** Indoor drift 45 m around Sargent → centroid stable

`place_visit/v1` pipeline-level (commit 4):

- **d.** First week, zero places → `place_id = NULL`, no false names
- **e.** Two buildings 80 m apart, distinct schedules → separate
- **f.** 45 s drive-by at a known place → no visit
- **g.** Visit spanning a window boundary → no duplicate or split
- **h.** Late-arriving GPS inside derived window → correct replay
- **i.** Mapbox 429/timeout → visit emitted with `place_id = NULL`
- **j.** Tied OSM matches → deterministic tie-break or NULL

## What's deferred

- Building polygon footprints from OSM into `places.footprint` —
  centroid + 50 m radius for v0; polygons in v1 if real data shows
  needed.
- Dashboard place-renaming UX — `UPDATE places SET name = ...`
  directly for v0.
- Manual large-place tagging (lakefill, parks) — appear as nameless
  visits with reverse-geocoded labels in v0.
- Topic chunks (per handoff: render-side, separate work).
- Weighted voting on OSM match — start with centroid → nearest;
  promote only if real data shows wrong attribution.
- Hampel speed-spike filter — accuracy filter alone for v0.
- Confidence indicator UI — commit 10, post-soak.
- Place override / alias tooling for misnamed OSM features —
  promote when actually needed.

## Open knobs (tune from real data after commit 8)

- SPD `dist_threshold_m`: 40 (start) → 25 if adjacent buildings merge
- SPD `time_threshold_min`: 8 (start) → up if drive-by stops register
- Hysteresis exit grace: 10 min (start)
- OSM match radius: 50 m (start)
- Min `match_confidence` to attribute a place (vs leave NULL): 0.6
- `gap_threshold_hours`: 4 (start)

## Risks I'm tracking

- **OSM data gaps.** Some Northwestern buildings may not be in OSM,
  or may lack the right tags. Mitigation: reverse-geocode fallback
  to street address.
- **Mapbox Tilequery rate limits.** Cache should make this fine for
  one-user backfill. If hit: switch to PostGIS + osm2pgsql.
- **Insufficient days of HIGH_ACCURACY data** (only one as of
  2026-04-29). The pipeline still runs; output is correct but
  early-day visits use older lower-accuracy GPS, with worse
  confidence scores. Acceptable.
- **Backfill correctness drift.** Once schemas are stable and the
  edge-case tests pass, backfill is a single command and idempotent.
  Re-runnable as we tune thresholds.

## Audit-driven changelog (2026-04-29)

Two audits (Plan + Codex) ran against the initial draft. The
following changes were applied:

- **Schema reconciliation.** The existing `places` table at
  `30_tables.sql:229-247` already has `name UNIQUE`, `schedule`,
  `metadata` columns; the migration is now additive (adds OSM ids,
  centroid, first/last_seen_ts), not a rewrite.
- **`provenance` field made first-class.** Schema CHECK at
  `30_tables.sql:97-106` requires `provenance.{inputs,
  source_event_ids}`. Initial draft would have CHECK-failed. Now
  every row shape declares it.
- **Audit metadata moved out of `data`.** `p95_accuracy_m` and
  `match_confidence` belong in `provenance`, not `data` — keeps
  payload aligned with `data-model.md §4` and the dashboard's
  `types.ts` (which doesn't have those fields).
- **`agent_api.replace_derived_window` now ships in commit 1b.**
  Original "single-user shortcut" silently bypassed the documented
  contract and `agent_role`'s SELECT-only grants. The RPC is small
  and avoids a security-model mutation.
- **Deterministic visit ids.** Replay safety for `travel_leg/v1`
  cross-references requires it.
- **`replace_window` semantics pinned** to delete-by-`start_ts` per
  `data-model.md §4`. No GiST overlap index — B-tree on
  `(source, start_ts)` is sufficient.
- **Dropped from v0:** `place_observations` table (use
  `provenance.source_event_ids`), `osm_lookup_cache` table
  (in-process LRU), `places.visit_count` / `total_dwell_s`
  (derived, query on demand), `places.footprint` (deferred),
  Hampel filter, weighted OSM voting, confidence indicator UI,
  `v_travel_leg_path` separate view (path inlined into `data`).
- **Commits resequenced.** Commit 1 split into 1a (schema) / 1b
  (framework + RPC). `v_active_mask` pulled into its own commit
  (5) since it's independent. Commit 4 grew the `bin/run_deriver.py`
  tool. Commit 10 added for post-soak confidence UI.
- **Test list expanded.** Added g–j for window-boundary, replay,
  Mapbox-down, and tied-vote cases. SPD-only cases (a–c) stay in
  commit 3; pipeline-level cases (d–j) move to commit 4 since they
  need OSM + hysteresis.
- **Per-run metrics.** Each deriver run logs/returns counts of
  dropped readings, stays detected, NULL-place visits, OSM errors,
  and the `match_confidence` distribution. Lets us judge runs
  without eyeballing rows.
- **Mapbox failure handling explicit.** Lookup in a separate `try`
  scope so OSM outage doesn't abort the deriver — visit emits with
  `place_id = NULL`.
- **`places.lat/lng` retained** as shadow columns until v1 to avoid
  breaking anything that already reads them; new code reads
  `centroid_lat/lng`.
