# Movement Model Redesign — Walks as First-Class Entities

**Status:** Design proposal. No code yet.
**Date:** 2026-04-30
**Author:** research pass grounded in trackintel + scikit-mobility prior art.

## 1. Problem Statement

Today's data model is `place_visit/v1` + `travel_leg/v1`. A leg row only
exists when there are two bracketing visits — `travel_leg/v1.data`
carries `from_visit_id` and `to_visit_id`, both required, and the
deriver iterates over `zip(visits, visits[1:])`
(`runtime/app/src/scrollantir/core/derivers/travel_leg.py:145`).

The bug: this morning the user walked 03:30 → 03:57. We have 38
high-quality GPS readings. The walk ended at home, but the dwell at the
destination was only ~3 minutes — below the (already lowered)
`time_threshold_min: 4.0` floor in `place_visit/v1`
(`runtime/app/src/scrollantir/core/derivers/place_visit.py:77`). No
destination visit was emitted. With only one bracketing visit (the
origin), `travel_leg/v1` cannot build a leg. The 27 minutes of motion is
**invisible despite abundant evidence**.

Lowering thresholds further is whack-a-mole. The structural problem is
that motion is modeled as **a derivative of two visits**, when in fact
motion is **a primitive observable** — we can see the GPS moving
regardless of whether the start/end of the motion qualifies as a stay.

This document proposes a redesign where motion segments (call them
*movements*) are first-class entities, derived directly from
positionfixes + a stay/move classifier, and only *optionally* linked to
bracketing visits.

The proposal is grounded in trackintel's six-class hierarchical model
(Martin et al. 2023, *trackintel: An open-source Python library for
human mobility analysis*, Computers, Environment and Urban Systems
101:101938) and cross-checked against scikit-mobility's stop-detection
API.

---

## 2. Prior Art Survey

### 2.1 trackintel's hierarchical model

trackintel exposes six classes, in increasing order of abstraction
(`trackintel/model/`):

1. **Positionfixes** — raw GPS points. Required cols: `user_id`,
   `tracked_at`, geometry. Optional FKs: `staypoint_id`, `tripleg_id`,
   both **nullable**.
2. **Staypoints** — runs where the user was stationary. Required cols:
   `user_id`, `started_at`, `finished_at`, point geometry. Optional FKs:
   `trip_id`, `location_id`, both **nullable**. Optional flag:
   `is_activity` (bool).
3. **Triplegs** — "continuous movement without changing the mode of
   transport." Required cols: `user_id`, `started_at`, `finished_at`,
   **LineString geometry**. Optional FK: `trip_id`, **nullable**.
   Optional: `mode_detected`, `mode_validated`.
4. **Locations** — clustered staypoints (multiple visits to the same
   place merged into one entity). Required: `user_id`, `center` Point.
5. **Trips** — "a collection of trip legs going from one activity
   (staypoint) to another." Required cols: `user_id`, `started_at`,
   `finished_at`, `origin_staypoint_id`, `destination_staypoint_id`.
   Both staypoint FKs **nullable** (the docs explicitly call out: "for
   gaps in recording").
6. **Tours** — round-trip sequences of trips ending at the start
   location.

Two consequences are load-bearing for our redesign:

> **Triplegs do not reference staypoints.** trackintel's `Triplegs`
> class has no `from_staypoint_id` / `to_staypoint_id` columns
> (verified in
> `trackintel/model/triplegs.py`). The only FK on Triplegs is the
> optional, nullable `trip_id`. A tripleg is a self-contained
> movement segment — it stands alone whether or not the broader Trip
> entity has been computed.

> **Trips bracket staypoints, not triplegs.** The `Trip` row carries
> `origin_staypoint_id` and `destination_staypoint_id`, both
> nullable. trackintel docs literally say "nullable for gaps in
> recording." A trip whose origin is unknown still emits, with
> `origin_staypoint_id = NULL`.

This is exactly the pattern we need.

### 2.2 trackintel's stay/move algorithms

**`generate_staypoints` (sliding window, Li et al. 2008)**
(`trackintel/preprocessing/positionfixes.py:_generate_staypoints_sliding_user`).

Defaults: `dist_threshold=100`, `time_threshold=5.0` (min),
`gap_threshold=15.0` (min), `include_last=False`,
`exclude_duplicate_pfs=True`.

The algorithm slides a window over each user's chronologically-sorted
positionfixes. For each anchor, it extends until either the distance
from anchor exceeds `dist_threshold` or the temporal gap from previous
fix exceeds `gap_threshold`. The run becomes a staypoint iff its
duration ≥ `time_threshold`. This is the same family of algorithm we
already use in `runtime/app/src/scrollantir/core/derivers/stay_points.py`
— derived from Zheng et al. 2009 ("Mining interesting locations and
travel sequences from GPS trajectories"), which is essentially the
sliding-window descendant of Li et al. 2008.

**`generate_triplegs`**
(`trackintel/preprocessing/positionfixes.py:generate_triplegs`).

Signature: `generate_triplegs(positionfixes, staypoints=None,
method='between_staypoints', gap_threshold=15)`.

The literal segmentation logic (paraphrased from source):

```python
# pfs has been annotated with a staypoint_id column where each
# positionfix that fell inside a staypoint carries that sp's id;
# others are NaN.

cond_new_user = (
    (pfs["user_id"] != pfs["user_id"].shift(1))
    & pd.isna(pfs["staypoint_id"])
)
cond_temporal_gap = (
    pfs["tracked_at"] - pfs["tracked_at"].shift(1)
    > timedelta(minutes=gap_threshold)
)
_stp_id = (pfs["staypoint_id"] + 1).fillna(0)
cond_stp = (_stp_id - _stp_id.shift(1)) != 0  # staypoint boundary

cond_all = cond_new_user | cond_temporal_gap | cond_stp
cond_all = cond_all & pd.isna(pfs["staypoint_id"])
# starting boundary is set on positionfixes that are NOT inside a stp
```

The output is one tripleg per maximal run of non-staypoint positionfixes
between boundary markers, with two filters:

1. Runs of length < 2 are dropped (a LineString needs 2 points).
2. Geometry validity check — `_drop_invalid_triplegs` removes
   self-intersecting LineStrings.

Critically: **a tripleg can begin or end without a bracketing staypoint
if the data simply doesn't have one** — the `cond_temporal_gap` and
`cond_new_user` triggers fire independent of staypoint context.
trackintel issue #27 ("Tripleg extraction is vulnerable to gaps in
tracking data") is the discussion that introduced the gap_threshold cut.

**`generate_trips`**
(`trackintel/preprocessing/triplegs.py:generate_trips`).

Trips are generated *after* both staypoints and triplegs exist. A trip
is a contiguous sequence of triplegs (and optionally non-activity
intervening staypoints — e.g., a 2-min wait at a bus stop) bracketed by
two **activity** staypoints (or by the start/end of the recording, with
the corresponding FK NULL).

A staypoint becomes "activity" via
`Staypoints.create_activity_flag(time_threshold=15.0 minutes)` or by
explicit semantic labelling. A 3-minute stop at the destination would
NOT be an activity in the default trackintel config — but it would
still emit as a staypoint (`is_activity=False`) and triplegs adjacent to
it would still emit.

Filter step in `generate_trips`: trips with zero triplegs are dropped
("There are no trips without a (recorded) tripleg"). Note the asymmetry
— a trip MUST have at least one tripleg, but a tripleg has no such
requirement of its parent trip.

### 2.3 scikit-mobility

`skmob.preprocessing.detection.stay_locations` — single function, emits
**only stops**, not move segments. Defaults: `minutes_for_a_stop=20.0`,
`spatial_radius_km=0.2`, `stop_radius_factor=0.5`. No tripleg
counterpart; movement is implicit in the trajectory between stops.

scikit-mobility is less rich than trackintel for our purposes — it
forces the same coupling we're trying to escape (motion as the absence
of a stop, not its own first-class entity). We adopt trackintel's model.

### 2.4 What this confirms

- **Motion segments and stationary segments are dual primitives**, both
  derived from positionfixes. Neither requires the other to exist.
- **The trip-level entity is where bracketing belongs** — and even then
  the FKs are nullable.
- The "is this point part of a stay or a move?" decision is best made
  *once*, by labelling each positionfix with `staypoint_id` (or NULL),
  and then running a trivial pass that groups contiguous NULL-runs into
  triplegs.

---

## 3. Proposed Scrollantir Model

### 3.1 New entities

**`place_visit/v1`** — unchanged in shape. Continues to mean "a stay
the user dwelled at long enough to count, with optional OSM place
match." This is trackintel's `Staypoint` with `is_activity=True`.

**`movement/v1`** — NEW. A continuous-motion segment derived directly
from GPS positionfixes. Independent of `place_visit/v1`. Schema:

```jsonc
{
  "id": "uuid (deterministic)",
  "source": "movement/v1",
  "start_ts": "first GPS reading in segment",
  "end_ts": "last GPS reading in segment",
  "data": {
    "from_visit_id": "uuid | null",   // <-- NULLABLE
    "to_visit_id":   "uuid | null",   // <-- NULLABLE
    "dominant_activity": "walking | running | on_bicycle | in_vehicle | unknown",
    "distance_m": 1234.5,
    "reading_count": 38,
    "path": [[lng, lat], ...]
  },
  "provenance": { /* same as travel_leg/v1 */ }
}
```

The single mechanical change vs. `travel_leg/v1`: **`from_visit_id` and
`to_visit_id` are nullable**. Everything downstream that ingests these
fields must treat them as optional.

**`trip/v1`** — DEFERRED. trackintel's Trip entity is genuinely useful
(it's the natural unit for "what was that errand?" semantic labelling)
but adding it now isn't load-bearing for the bug we're fixing. Note it
in the design but do not implement in v1. The future Trip entity:

```jsonc
{
  "source": "trip/v1",
  "data": {
    "origin_visit_id":      "uuid | null",
    "destination_visit_id": "uuid | null",
    "movement_ids": ["uuid", "uuid", ...],   // ordered
    "intermediate_visit_ids": ["uuid", ...]  // non-activity stays
  }
}
```

### 3.2 Why nullable bracketing FKs?

Four cases where one or both FKs are NULL, all real:

| Case | from_visit_id | to_visit_id | Cause |
|------|---------------|-------------|-------|
| 03:30-03:57 walk ending in 3-min stop | non-null | NULL | destination dwell below `time_threshold_min` |
| morning departure where overnight visit had no GPS | NULL | non-null | indoor stay never emitted because no GPS |
| pure pass-through movement (rare) | NULL | NULL | tracking started mid-trip and ended mid-trip |
| the "expected" case | non-null | non-null | typical commute |

trackintel's docs explicitly support all four. The current Scrollantir
model only supports the last.

### 3.3 Activity-flag semantics (deferred)

trackintel separates `is_activity=True` (a "real" stop with semantic
content) from `is_activity=False` (a transient stop — bus wait,
crosswalk pause, brief errand). Today our `place_visit/v1` rows are
implicitly all activities — the `time_threshold_min: 4.0` floor (down
from 8.0) acts as the activity gate.

Adopting the explicit flag would let us record the 3-min terminal stop
of the morning walk as a `place_visit/v1` row with
`is_activity=False`, which would then satisfy the "destination" half of
the movement segment without surfacing as a real visit on the dashboard.

This is appealing but cross-cutting: it forces a UX decision (does the
day timeline show non-activity stays?) and a deriver-chain change
(does `place_visit/v1` lower its threshold and add `is_activity`, or do
we add a sibling `place_visit/v2` with both kinds?). Defer to a later
design pass. For v1, we get the same end-state by allowing
`movement/v1` to nullably bracket — the 3-min stop simply doesn't exist
as any row, and the movement still emits.

---

## 4. The Stay/Move Classifier

The core algorithmic change is to **label each positionfix once** as
either "inside a stay" or "in motion," then derive both visits and
movements from that single labelling. This mirrors trackintel's
positionfixes-as-canonical pattern.

### 4.1 Pseudocode

```
INPUT: chronologically-sorted positionfixes for [window_start, window_end]
       with lookback (already done — see place_visit.compute lookback)

PARAMETERS (initial values match current SPD config):
  accuracy_max_m       = 30.0
  dist_threshold_m     = 40.0
  time_threshold_min   = 4.0   # for is_activity=True visit
  gap_threshold_min    = 10.0  # NEW: positionfix-level gap that
                               # breaks runs (was implicit at 4 hours
                               # for stays; 10 min is the trackintel
                               # default for triplegs and matches our
                               # brief_exit_max_gap_min)
  min_points           = 3

PASS 1 — accuracy filter
  pfs = [p for p in positionfixes if p.accuracy_m <= accuracy_max_m]

PASS 2 — sliding-window stay detection (exact current algorithm)
  stays = extract_stay_points(pfs, ...)
  # Each stay carries a tuple of source positionfix ids.

PASS 3 — annotate each pf with stay_id (mirrors trackintel)
  for stay in stays:
      for pf_id in stay.event_ids:
          pf_by_id[pf_id].stay_id = stay.id
  # pfs not inside any stay have stay_id = None

PASS 4 — emit visits (place_visit/v1, unchanged shape)
  visits = OSM-match + brief-exit-merge + same-place-merge over stays
  # See section 5 for how same-place-merge interacts with movements.

PASS 5 — emit movements (movement/v1)
  # trackintel-style boundary detection
  current_segment = []
  for i, pf in enumerate(pfs):
      if pf.stay_id is not None:
          flush_segment(current_segment)
          current_segment = []
          continue
      if i > 0:
          prev = pfs[i - 1]
          gap_min = (pf.ts - prev.ts).total_seconds() / 60
          # boundary if: previous pf was inside a stay, OR
          #              gap exceeds threshold
          if prev.stay_id is not None or gap_min > gap_threshold_min:
              flush_segment(current_segment)
              current_segment = []
      current_segment.append(pf)
  flush_segment(current_segment)

  def flush_segment(seg):
      if len(seg) < 2:
          return  # need ≥2 points for a LineString
      # find bracketing visits, if any
      from_visit = visit_ending_at_or_before(seg[0].ts)
      to_visit   = visit_starting_at_or_after(seg[-1].ts)
      # gap-aware bracketing: only attach a visit if the gap between
      # the visit boundary and the segment boundary is small
      # (≤ gap_threshold_min). Otherwise NULL — we don't know what
      # happened in between.
      from_visit_id = from_visit.id if (
          from_visit and (seg[0].ts - from_visit.end_ts) <= timedelta(minutes=gap_threshold_min)
      ) else None
      to_visit_id = to_visit.id if (
          to_visit and (to_visit.start_ts - seg[-1].ts) <= timedelta(minutes=gap_threshold_min)
      ) else None
      emit movement/v1 with (from_visit_id, to_visit_id, path=seg)
```

### 4.2 Algorithm notes

- Pass 5 is essentially trackintel's `generate_triplegs` with
  `method='between_staypoints'` and `gap_threshold=10`.
- The **gap-aware bracketing** in `flush_segment` is our addition.
  trackintel-proper attaches movements purely positionally (the next
  staypoint after the segment ends is the destination). We additionally
  require the visit boundary be temporally close to the segment
  boundary, otherwise we leave the FK NULL. This handles the case where
  there was a long silent stretch between a known visit and the start
  of motion — we don't pretend the visit "ended" at the start of
  motion if it actually ended hours earlier.
- The current `_smooth_path` (sub-second dedup + activity-aware
  spike-drop) lives here unchanged.
- `dominant_activity` is computed the same way as today, by querying
  `phone.activity.state` events overlapping the segment span.

### 4.3 Why a single classifier pass

Today `place_visit/v1` and `travel_leg/v1` are independent derivers
that both fetch positionfixes from the events table. They label fixes
implicitly — `place_visit/v1` decides which fixes contributed to a
stay; `travel_leg/v1` decides which fixes contributed to a leg path.
The two labellings are NOT explicitly reconciled. A fix could end up in
both (it sometimes does — see the 70m-short-of-the-building issue
mentioned in `travel_leg.py:118-124` that was patched by making the
path query inclusive of the visit's first reading).

trackintel reconciles by carrying `staypoint_id` and `tripleg_id` as
columns ON the positionfixes table. We don't have a positionfixes table
— we have a generic events table. But we can still do the equivalent
**inside a single deriver run**: build the labelling once in memory
during the deriver, emit both kinds of derived rows from that single
labelling.

Mechanically, that suggests one of two implementation shapes:

- **Option A (recommended)**: a `stay_and_move/v1` deriver that emits
  both `place_visit/v1` and `movement/v1` rows. The `source` field on
  each emitted DerivedRow distinguishes them.
- **Option B**: keep two derivers, but have `movement/v1` consume the
  same SPD output by re-running the stay extraction in-process. More
  duplicated work; same end-state.

Option A is closer to trackintel's pattern and has less cache surface.
But it requires the deriver harness to support a single deriver
emitting multiple `source` values per run. (The current registry seems
to assume `SOURCE` is a singleton on each deriver.) If that lift is too
big, fall back to Option B.

---

## 5. Walkthrough: The Two Bug Cases

### 5.1 Today's morning walk (3:30 → 3:57, 3-min terminal stop)

**Today (broken):**
1. `place_visit/v1` runs SPD over the GPS readings.
2. The 3:30 origin is a long stay (overnight at home) — emits a visit.
3. The 3:30-3:57 walk readings don't form a stay — no visit.
4. The 3:57 destination cluster is 5 readings over ~3 minutes — fails
   `time_threshold_min: 4.0` — no visit.
5. `travel_leg/v1` runs. Sees one visit (the 3:30 origin) overlapping
   the window. `zip(visits, visits[1:])` is empty. **Zero legs.**
6. Dashboard renders the raw GPS as a fallback path
   (`8a6cda2 dashboard/today: render raw GPS as fallback path on
   user_active spans`) — the workaround.

**With the new model:**
1. Single deriver pass: SPD finds the 3:30 origin stay only.
2. Pass 3 labels: positionfixes between 3:30 and the origin's last
   reading carry `stay_id = origin_visit.id`. Positionfixes from
   3:30 onward carry `stay_id = None`.
3. Pass 5 walks the unlabelled run. It sees a 38-point continuous run
   from 3:30:xx (first post-origin pf) to 3:57:xx with no
   gap > 10 minutes. Flushes one movement segment.
4. `from_visit_id` resolves to the origin visit (gap ≈ seconds).
   `to_visit_id` resolves to NULL (no qualifying visit ends with this
   segment).
5. Movement emits with 38 path points, distance ~1.2km, dominant
   activity walking.
6. Dashboard renders the walk as a real movement entity. The
   raw-GPS-fallback hack can be retired.

The 3-minute terminal stop is silent — no visit row. That's correct: we
don't have evidence to call it a destination. If we later add the
`is_activity` flag (section 3.3), it could show as a low-confidence
stop. For now, NULL `to_visit_id` is the honest representation.

### 5.2 The same-place-merge case (commit 2d24a30)

The case: user is home overnight; phone's GPS-attestation gate drops
indoor WiFi readings; SPD sees two separate short outdoor stays at home
(e.g., 6pm-6:05pm at the door, then 7am-7:10am at the door) with 13
hours of silence between. Without intervention these emit as two
`place_visit/v1` rows.

The current fix is `_merge_same_place_long_gaps` in `place_visit.py:302-347`
— a post-pass that collapses consecutive visits with the same
non-null `place_id` and gap ≤ 12 hours. **We must preserve this.**

**With the new model:**

1. SPD emits two short stays at home, OSM matches both to
   `place_id=HOME`.
2. `_merge_same_place_long_gaps` runs as today, collapses to one
   visit spanning 6pm-7:10am.
3. Pass 3 labels: both clusters of positionfixes carry the merged
   visit's id. Positionfixes between them (if any survived the gate)
   would have `stay_id = None`.
4. Pass 5 walks the unlabelled positionfixes between the clusters. If
   the gap between the last pre-gap pf and the first post-gap pf is
   > 10 min (it's 13 hours), `cond_temporal_gap` fires — but there are
   no pfs *inside* that gap to flush, so no movement emits.
5. Net: one merged visit, zero spurious movements. **Same outcome as
   today's fix.**

The merge runs *before* the movement pass (or inline with it; order
matters but is straightforward) so that the labelling in Pass 3 uses
the merged visit's id, not the pre-merge id.

There's a subtle interaction: today, `place_visit/v1`'s deterministic
id is `uuid5(start_ts, lat, lng)`, and the merge keeps the earlier
id. For movements that bracket the merged visit, the FK is the merged
id — which is the earlier of the two pre-merge ids. Replays produce
identical merged ids, so movement deterministic ids
(`uuid5(from_visit_id, to_visit_id, segment_start_ts)`) stay stable.

### 5.3 Edge case: movement spanning a window boundary

The current `travel_leg/v1` uses `IDEMPOTENCY_MODE = OVERLAP_REPLACE`.
The new `movement/v1` should do the same. Pass 5 in section 4.1 should
operate over the lookback-extended pf range (not just the window
range), and emit movements whose span overlaps the window. trackintel's
analog: `generate_triplegs` doesn't operate on "windows" — it operates
on whole-user-trajectories — but we have to bound work somehow, hence
the lookback pattern.

### 5.4 Edge case: short jitter inside a stay

The `merge_brief_exits` pass
(`runtime/app/src/scrollantir/core/derivers/stay_points.py:162-214`)
already handles "step outside Norris for 5 minutes and come back" by
merging consecutive same-anchor stays separated by ≤ 10 minutes.

In the new model: if the brief exit involves real GPS readings of
motion (a quick outdoor walk to/from the bathroom of an adjacent
building), should those readings emit as a movement?

**Decision: no.** When `merge_brief_exits` collapses two stays into
one, the positionfixes from the brief exit are NOT inside either
original stay's `event_ids`, so Pass 3 would label them `stay_id =
None`. But the temporal gap is ≤ 10 minutes by construction. To
suppress the spurious movement: after `merge_brief_exits`, **re-label
the in-between positionfixes with the merged stay's id**. This says
"we treat the brief exit as part of the stay, not as a movement."

This matches today's behavior — `travel_leg/v1` doesn't emit a leg
inside a brief-exit-merged visit because the visit's span covers the
gap and `zip(visits, visits[1:])` skips intra-visit time.

---

## 6. Migration Plan

### 6.1 Coexistence phase

Ship `movement/v1` alongside `travel_leg/v1`. Both derive from the same
positionfixes; both are deterministic and idempotent. They will produce
overlapping output during the transition.

Dashboard reads `movement/v1` directly. The renderer for `travel_leg/v1`
becomes a thin adapter that maps the two-non-null-FK rows into the
movement format. Eventually the adapter is deleted and `travel_leg/v1`
deriver is retired.

Concretely:

1. **Commit 1**: add `movement/v1` deriver (Option A or B per section
   4.3). Dashboard ignores it.
2. **Commit 2**: add a new `v_movements_today` SQL view (analogous to
   the existing `v_place_visit_today`). Dashboard fetches it.
3. **Commit 3**: dashboard renders `movement/v1` rows. Falls back to
   `travel_leg/v1` for movements where both FKs are non-null AND no
   `movement/v1` row exists with the same span (shouldn't happen, but
   safety belt during migration).
4. **Commit 4**: retire `travel_leg/v1` deriver. Mark its source as
   deprecated in the registry. Old rows stay in the table for
   historical query but no new ones are generated.
5. **Commit 5**: drop the dashboard fallback path
   (`8a6cda2`-introduced raw-GPS render) since it's no longer needed —
   `movement/v1` covers the case it was workaround for.

### 6.2 Schema impact

`movement/v1` reuses the existing `derived_events` JSONB row model.
**No SQL migration is required for the deriver itself** — `data` is a
JSONB blob and we're just adding a new `source` value.

The dashboard fetcher's `TravelLeg` TypeScript type will need a
companion `Movement` type with `from_visit_id?: string | null` and
`to_visit_id?: string | null`. The map's mode-keyed layer filter
already handles `dominant_activity`; the only change is the optional
FKs.

Existing `travel_leg/v1` rows in the database remain readable forever.
We do not delete them.

### 6.3 Renaming question

`movement` vs `tripleg` vs `motion` vs `leg`. The trackintel term is
"tripleg" but it's somewhat opaque to new readers. `movement/v1` is
clearer. `travel_leg/v1` is what we have today and the name implies
bracketing — bad fit.

**Recommendation**: `movement/v1`. It pairs cleanly with `place_visit/v1`
("places where the user was; movements between them") and doesn't carry
the bracketing connotation. (If a future Trip entity comes in, naming it
`trip/v1` is uncontroversial.)

---

## 7. Tests to Adopt from trackintel

trackintel's test suite (`tests/preprocessing/test_positionfixes.py`)
covers cases worth porting:

- **`test_user_without_sp`** — trajectory with no qualifying staypoints
  should still emit triplegs. Our analog: GPS readings spanning a
  window with no stays at all (e.g., user is in transit the whole
  window) should produce one or more movements.
- **`test_pfs_without_sp`** — the case where staypoint pfs are deleted
  before tripleg generation. Our analog: tests for the case where SPD
  rejects all pfs (accuracy filter, min_points) but there are still
  movement-eligible pfs.
- **`test_temporal`** — verifies `gap_threshold` correctly cuts long
  gaps. Our analog: a 12-hour gap between two clusters of pfs should
  produce two movements, not one mega-movement bridging the gap.
- **`test_invalid_isolates`** — drop runs with too few points. Our
  analog: a single isolated pf in a no-stay window should not produce a
  zero-length movement.
- **`test_sp_tpls_overlap`** — verifies stays and triplegs do not
  overlap in time. **Critical for us** — the today-shipped path query
  is inclusive at the visit boundary specifically to recover the last
  reading; in the new model, the labelling-once approach gives this
  for free, but we should explicitly test that no positionfix appears
  in both a visit's `event_ids` and a movement's `path`.

Additional Scrollantir-specific cases:

- **The 3:30-3:57 walk case** itself, with the 3-min terminal stop —
  fixture inputs from real data, asserts one movement with `from_visit
  != null`, `to_visit = null`.
- **The same-place-merge case** (commit 2d24a30) — fixture with two
  short same-place stays separated by 13 hours, asserts one merged
  visit and zero spurious movements.
- **The brief-exit case** — two stays at the same anchor separated by
  a 5-min walk, asserts one merged visit and zero movements.
- **Determinism / replay** — running the deriver twice over the same
  window produces identical row ids and identical content.
- **`OVERLAP_REPLACE` correctness** — running over `[t1, t2]` then
  `[t2, t3]` produces the same set of movements as running over
  `[t1, t3]` once.

---

## 8. Open Questions

1. **`is_activity` flag (section 3.3)** — should we adopt it now, in a
   later pass, or never? Affects whether the 3-min terminal stop ever
   gets a row.
2. **Single deriver vs two derivers (section 4.3 Option A vs B)** —
   depends on the harness's tolerance for multi-source derivers.
3. **`gap_threshold_min` for movement segmentation** — trackintel
   defaults to 15. We have `brief_exit_max_gap_min: 10.0` for stays.
   Use 10 for symmetry, or pick a different value? If a user is in
   transit and GPS drops out for 12 minutes (subway), do we want one
   movement or two?
4. **Trip entity** — defer to a later design pass, or sketch the schema
   now to avoid lock-in?

---

## 9. Summary

The structural fix: **let movements exist independently of visits.**

The implementation: **label positionfixes once, emit visits and
movements from a single labelling**, mirroring trackintel's pattern.
Bracketing FKs become nullable.

The bug fix that motivated this: **the 3:30-3:57 walk emits as a
movement with `from_visit_id = origin`, `to_visit_id = NULL`** — and
shows up on the dashboard as a real entity, not a fallback render of
raw GPS.

Cost: one new deriver, one new dashboard view, one TypeScript type
update, ~5 new tests, and a 5-commit migration that ends with a
cleaner model and the raw-GPS fallback retired.

---

## References

### trackintel
- Martin et al. 2023, *Trackintel: An open-source Python library for
  human mobility analysis*, Computers, Environment and Urban Systems
  101:101938. [arxiv](https://arxiv.org/pdf/2206.03593),
  [eth](https://www.research-collection.ethz.ch/server/api/core/bitstreams/5cb0fb19-3f09-472b-984b-17a3eaf4b834/content).
- `trackintel/preprocessing/positionfixes.py` —
  `generate_staypoints` (sliding-window, Li et al. 2008) and
  `generate_triplegs` (`between_staypoints` / `overlap_staypoints`).
- `trackintel/preprocessing/triplegs.py` — `generate_trips`.
- `trackintel/model/staypoints.py`, `trackintel/model/triplegs.py`,
  `trackintel/model/trips.py` — class schemas. Confirmed: Triplegs
  have no staypoint FKs; Trips have nullable
  `origin_staypoint_id`/`destination_staypoint_id`.
- trackintel docs:
  https://trackintel.readthedocs.io/en/latest/modules/model.html
- trackintel issue #27 — "Tripleg extraction is vulnerable to gaps in
  tracking data," motivates `gap_threshold` cut.

### Stay-point detection
- Li et al. 2008, *Mining user similarity based on location history*.
  Original sliding-window staypoint algorithm.
- Zheng et al. 2009, *Mining interesting locations and travel sequences
  from GPS trajectories*. The variant Scrollantir's current SPD
  derives from (`runtime/app/src/scrollantir/core/derivers/stay_points.py`).

### scikit-mobility
- `skmob/preprocessing/detection.py` — `stay_locations`. Stops-only,
  no triplegs. Less rich than trackintel for our use case.

### Scrollantir
- `runtime/app/src/scrollantir/core/derivers/place_visit.py` —
  current visit deriver, including `_merge_same_place_long_gaps`
  (commit 2d24a30, must preserve).
- `runtime/app/src/scrollantir/core/derivers/travel_leg.py` —
  current leg deriver with the bracketing constraint we're relaxing.
- `runtime/app/src/scrollantir/core/derivers/stay_points.py` — SPD
  core, will be reused in the new pipeline.
- Commit `8a6cda2` — dashboard raw-GPS fallback (retire after
  migration).
- Commit `2d24a30` — same-place long-gap merge (preserved as-is).
- `docs/sessions/session-2026-04-29-gps-noise.md` — context for the
  GPS-attestation gate that creates the indoor-no-GPS visit-fragmentation
  case.
