# Mobility Libraries — Install, Port, or Different?

**Status:** Research, complete.
**Date:** 2026-04-30.
**Question:** For Scrollantir's stays-and-movement model, should we install
`trackintel`, port its concepts into our own code, or use a different
library?

---

## 1. Verdict

**Port `generate_triplegs`'s segmentation logic into a small in-repo helper
(~80-120 LOC). Do not install trackintel, scikit-mobility, or MovingPandas
as a runtime dependency.**

The user's instinct ("if you have to patch something over it, that's sus")
holds. trackintel is the closest conceptual fit — its
staypoint/tripleg/trip hierarchy is the abstraction we already want — but
adopting the *library* would require (a) materializing a Positionfixes
GeoDataFrame per deriver run, (b) reverse-mapping its auto-incrementing
int64 IDs onto our `uuid5(start_ts, coords)` deterministic-id contract,
(c) pulling pandas + geopandas + shapely + numpy + scikit-learn +
matplotlib + osmnx + networkx + similaritymeasures + geoalchemy2 + tqdm
into a runtime image whose total today is ~70-100 MB (a ~3x bloat for one
feature), and (d) wrapping every Scrollantir-specific concern (OSM
matching, `_merge_same_place_long_gaps`, brief-exit merge,
GPS-attestation gating, activity voting, deterministic IDs) around the
library in glue code that ends up larger than the algorithm it's
wrapping. The algorithmic content we want — `generate_triplegs`
boundary-detection — is ~30 lines of vectorized pandas in trackintel,
~40 lines of pure-Python loop in our shape. The full movement deriver
slots into existing `core/derivers/` with no framework changes.

scikit-mobility is dormant (last release 2024-05-25, pinned to
pandas ^1.1.5) and stops-only. MovingPandas is healthy and lighter, but
also stops-only — `TrajectoryStopDetector` is a stop-finder, not a
trip-segmenter. Both force the exact stops-only / motion-as-absence-of-
a-stop coupling that `movement-model-design.md` is fixing.

The concepts to import (without code) — nullable bracketing FKs,
single-pass labelling, gap-threshold segmentation, `is_activity` flag —
are already documented in `movement-model-design.md` and fully portable
without any library.

---

## 2. trackintel

### 2.1 Repo health and license

- Last commit `f7bf6fd` 2026-04-14; substantive commits within 60 days
  (`87b8b50` 2026-03-10, `2a18258` 2026-02-20). 261 stars, 24 open
  issues, MIT, not archived. Active maintainer (ETH Zürich MIE Lab).
- PyPI: `trackintel==1.4.2`, py3-none-any wheel 152 KiB.
- License (MIT) compatible.

### 2.2 Install footprint

`setup.py` runtime deps (verified 2026-04-30 via `gh api`):
`pandas, geopandas>=0.12.0, matplotlib, numpy, shapely, geoalchemy2,
osmnx, scikit-learn, tqdm, similaritymeasures`.

Largest-wheel sizes (current PyPI versions):

| Package | Largest wheel |
|---|---|
| matplotlib 3.10.9 | 34 MB |
| numpy 2.4.4 | 20 MB |
| pandas 3.0.2 | 12 MB |
| scikit-learn 1.8.0 | 9 MB |
| shapely 2.1.2 | 4 MB |
| networkx 3.6.1 (via osmnx) | 2.5 MB |
| Other (geopandas, osmnx, geoalchemy2, similaritymeasures, tqdm) | ~1.5 MB |
| trackintel itself | 0.15 MB |
| **Compressed total** | **~83 MB** |
| **Installed total (typical 3x)** | **~250 MB** |

Current Scrollantir runtime: `python:3.12-slim` (~45 MB) + fastapi +
uvicorn + apscheduler + psycopg[binary] + pydantic + httpx ≈ 70-100 MB.
Adding trackintel roughly triples the image. Tenet 7 fires.

`osmnx` is a particularly indulgent transitive dep — heavy OSM network-
graph builder pinned to networkx ≥2.5; trackintel uses only a fraction
of it.

### 2.3 API ergonomics — what an integration looks like

trackintel's API is DataFrame-shaped
(`trackintel/preprocessing/positionfixes.py`):

```python
generate_staypoints(
    positionfixes,                  # GeoDataFrame: user_id, tracked_at,
                                    # geometry; tz-aware datetimes
    method='sliding',
    dist_threshold=100,             # METERS
    time_threshold=5.0,             # MINUTES
    gap_threshold=15.0,             # MINUTES
    include_last=False,
    exclude_duplicate_pfs=True,
    n_jobs=1,
) -> (Positionfixes, Staypoints)

generate_triplegs(
    positionfixes,                  # must have staypoint_id col
    staypoints=None,
    method='between_staypoints',    # | 'overlap_staypoints'
    gap_threshold=15,               # MINUTES
) -> (Positionfixes, Triplegs)
```

A literal integration:

```python
# (sketch — what we'd write to USE the library)
import pandas as pd, geopandas as gpd, trackintel as ti

class StayAndMoveV1Deriver(DeterministicDeriver):
    def compute(self, conn, start, end):
        # 1. psycopg rows -> GeoDataFrame
        rows = self._fetch_readings(conn, start, end)
        df = pd.DataFrame({
            "user_id": ["josh"] * len(rows),
            "tracked_at": pd.to_datetime([r.ts for r in rows], utc=True),
            "raw_event_id": [str(r.id) for r in rows],
            # accuracy filter inline
        })
        df = df[df["accuracy_m"] <= 30.0]
        gdf = gpd.GeoDataFrame(
            df, geometry=gpd.points_from_xy(df["lng"], df["lat"]),
            crs="EPSG:4326")
        pfs = ti.Positionfixes(gdf)

        # 2. Run trackintel
        pfs, sps = pfs.generate_staypoints(
            method="sliding", dist_threshold=40.0,
            time_threshold=4.0, gap_threshold=240.0)
        pfs, tpls = pfs.generate_triplegs(
            staypoints=sps, method="between_staypoints",
            gap_threshold=10.0)

        # 3. sps -> place_visit/v1 DerivedRow with our uuid5 contract.
        # Each sp has int64 .index; we have to reverse-look-up its
        # contributing positionfixes via pfs[pfs.staypoint_id == idx]
        # to populate provenance.source_event_ids.
        # Then: brief-exit merge, OSM lookup, same-place merge, place
        # upsert — all bespoke, kept verbatim, ~80 LOC.

        # 4. tpls -> movement/v1 DerivedRow.
        # LineString -> [[lng,lat]...]; activity voting (DB query, not
        # in trackintel); _smooth_path verbatim (90 LOC); bracket against
        # visits with gap-aware nullability.

        return rows, metrics
```

LOC for this wrapper:

| Section | LOC |
|---|---|
| GeoDataFrame materialization + dtype dance | 25 |
| trackintel call + result munging | 10 |
| sps → DerivedRow with uuid5 + reverse-lookup of source_event_ids | 30 |
| OSM match + brief-exit + same-place merge (kept verbatim) | 80 |
| tpls → DerivedRow with bracketing | 35 |
| `_smooth_path` (kept verbatim) | 90 |
| `_dominant_activity` (kept verbatim) | 25 |
| **Subtotal** | **~295 LOC** |

vs. the port baseline (no library): **~135 LOC** (see §5). The library
saves ~30-50 LOC of segmentation and costs ~50-80 LOC of GeoDataFrame
plumbing and ID round-tripping. Net break-even or worse on lines, with
worse runtime cost (DataFrame allocation per tick, group-by ops, shapely
Point construction) and a 250 MB image bloat.

### 2.4 Configurability of our knobs

| Scrollantir knob | trackintel equivalent | Match? |
|---|---|---|
| `accuracy_max_m=30.0` | none — pre-filter ourselves | 1-liner |
| `dist_threshold_m=40.0` | `dist_threshold=100` (m) | yes |
| `time_threshold_min=4.0` | `time_threshold=5.0` (min) | yes |
| `gap_threshold_hours=4.0` | `gap_threshold=15.0` (min) | yes (units) |
| `min_points=3` | none — Li et al. 2008 has no min-points guard | NO, post-pass |
| `brief_exit_max_gap_min=10.0` | `Staypoints.merge_staypoints(triplegs, max_time_gap='10min')` | partial (different shape) |
| `osm_match_radius_m=50` | none, OSM out of scope | bespoke |
| `same_place_max_gap_hours=12.0` | `merge_staypoints` is gap-bound, not place-id-bound | NO, post-pass |
| `path_accuracy_max_m=75.0` | none, 1-liner | n/a |

`min_points=3` and `same_place_max_gap_hours=12.0` are exactly the
Tenet-4 magic numbers tuned from real data
(`stay_points.py:90-104`, commit `2d24a30`). They have no trackintel
counterpart and would remain post-passes outside the library regardless.

### 2.5 Idempotency / deterministic IDs

trackintel emits monotonic int64 IDs at emission time
(`sp["staypoint_id"] = sp.index; sp.index = sp.index.astype("int64")`).
Stable within one call but not across replays if the input changes.

Our `DeterministicDeriver` requires `uuid5(NAMESPACE_URL, ...)` from row
content (`place_visit.py:280-299`). Strategy: ignore trackintel's ints,
recompute uuid5 from row content, use the int index only as a within-run
join key for `staypoint_id ↔ tripleg_id` cross-reference on pfs.

Cost: every replay we walk
`pfs[pfs["staypoint_id"] == idx]["raw_event_id"]` to recover contributing
event IDs for `provenance.source_event_ids`. Today's
`extract_stay_points` returns those IDs *as part of the StayPoint
dataclass* (`event_ids: tuple[UUID, ...]`, `stay_points.py:62`) — the
direct shape we want. trackintel forces a reverse-lookup that today is
free.

### 2.6 What trackintel does NOT do for us

OSM matching via Mapbox Tilequery (`core/osm.py`); `places` upserts
(`places_repo.py`); Android Activity Recognition mapping for
`dominant_activity` (trackintel offers speed-based
`predict_transport_mode('simple-coarse')`, different signal);
activity-aware spike smoothing (`_smooth_path`); the
place-id-bound `_merge_same_place_long_gaps` (commit `2d24a30`;
trackintel's `merge_staypoints` is gap-bound only); deterministic
uuid5 IDs; `OVERLAP_REPLACE` lookback; agent_api
`replace_derived_window` RPC.

This is the load-bearing surface of our pipeline. trackintel covers the
~30-line algorithmic core; we own everything else.

---

## 3. scikit-mobility

**Dormant.** `pushed_at: 2024-05-25` (~23 months stale as of 2026-04),
802 stars, 67 open issues, BSD-3-Clause. `pyproject.toml` pins
`pandas = "^1.1.5"` (current is 3.0.2 — deal-breaker), plus
`python-igraph ^0.9.1` (heavy native dep), `folium 0.12.1.post1`
(pinned), `geojson ^2.5.0`, `powerlaw`.

`skmob/preprocessing/detection.py::stay_locations` defaults
`stop_radius_factor=0.5, minutes_for_a_stop=20.0, spatial_radius_km=0.2`.
Inside `_stay_locations_array`: anchor on first reading; if
`Dr > stop_radius` AND `Dt > minutes_for_a_stop` emit a stop with
median(lat,lng) of the run; if prev-fix gap > `no_data_for_minutes`
reset. **Same family** of sliding-window algorithm as
trackintel's `_generate_staypoints_sliding_user` and our own
`extract_stay_points`; all three derive from Li et al. 2008 / Zheng
2015. Differences are cosmetic (median-coords vs accuracy-weighted
centroid vs shapely-centroid).

scikit-mobility emits **stops only**, no tripleg counterpart — exactly
the coupling `movement-model-design.md` is fixing. We'd still write
segmentation ourselves *and* inherit pinned-old-pandas. Skip.

---

## 4. MovingPandas

**Healthy.** `pushed_at: 2026-04-23`, 1395 stars, 33 open issues,
BSD-3-Clause. Maintained by Anita Graser; healthy release cadence.

`pyproject.toml` runtime deps: `matplotlib, geopandas, geopy`. Three
direct deps but geopandas pulls pandas + shapely + numpy + pyproj.
Installed footprint ~150-200 MB — better than trackintel (no
scikit-learn/osmnx/networkx) but still ~3x the current image.

API: `TrajectoryStopDetector(traj).get_stop_time_ranges(max_diameter,
min_duration)` (also `get_stop_segments`, `get_stop_points`).
**Stops-only**, like scikit-mobility. There IS a `TrajectorySplitter`
(`StopSplitter(traj).split(...)` returns a TrajectoryCollection of
move-segments), but those are trajectories, not the dual stop/move
primitives we want.

Better-maintained and lighter than trackintel for the stop-detection
sub-problem; doesn't give us the conceptual model. Same wrapper-around-
foreign-DataFrame-API pattern with less leverage. Skip.

---

## 5. Port-the-model baseline

### 5.1 What we already have

- `extract_stay_points(readings, ...)` →  `list[StayPoint]` with
  `event_ids: tuple[UUID, ...]` per stay
  (`stay_points.py:82-159`). Equivalent of trackintel's
  `generate_staypoints` step. **No port needed.**
- `merge_brief_exits(stays)` (`stay_points.py:162-214`). Equivalent of
  `merge_staypoints` for the bathroom-break case. **No port needed.**
- `_merge_same_place_long_gaps` (`place_visit.py:302-347`). No
  trackintel counterpart. **Keep.**
- OSM lookup, place upsert, deterministic uuid5, activity voting, path
  smoothing — all bespoke. **Keep.**

### 5.2 What's new

The segmentation pass mirroring `generate_triplegs:cond_all`:

```python
def generate_movements(
    readings: Sequence[GPSReading],
    stays: Sequence[StayPoint],
    *,
    gap_threshold_min: float = 10.0,
    min_points: int = 2,
) -> list[MovementSegment]:
    """Mirror trackintel.generate_triplegs(method='between_staypoints').

    A new segment starts at a positionfix that is (a) outside any stay
    AND (b) one of: first reading, preceded by a stay-fix, or preceded
    by a temporal gap > gap_threshold_min. Segments with < min_points
    readings are dropped.
    """
    if not readings:
        return []
    pf_to_stay: dict[UUID, int] = {}
    for i, stay in enumerate(stays):
        for eid in stay.event_ids:
            pf_to_stay[eid] = i

    gap_s_max = gap_threshold_min * 60.0
    segments: list[list[GPSReading]] = []
    current: list[GPSReading] = []

    def _flush() -> None:
        nonlocal current
        if current:
            segments.append(current)
            current = []

    for i, pf in enumerate(readings):
        if pf.id in pf_to_stay:
            _flush(); continue
        if i > 0:
            prev = readings[i - 1]
            gap_s = (pf.ts - prev.ts).total_seconds()
            if prev.id in pf_to_stay or gap_s > gap_s_max:
                _flush()
        current.append(pf)
    _flush()

    return [
        MovementSegment(
            start_ts=seg[0].ts,
            end_ts=seg[-1].ts,
            event_ids=tuple(p.id for p in seg),
            path=[(p.lng, p.lat) for p in seg],
        )
        for seg in segments
        if len(seg) >= min_points
    ]
```

~50 lines incl. docstring, plus a 6-line `MovementSegment` dataclass.
Pure Python, deterministic, no external deps.

### 5.3 LOC budget for the full `movement/v1` deriver

| Section | LOC |
|---|---|
| `MovementSegment` dataclass | 10 |
| `generate_movements` | 55 |
| `MovementV1Deriver.compute` (visit fetch + segment + per-seg row) | 45 |
| Bracketing (find from/to visit, gap-aware nullability) | 25 |
| Reuse (`_smooth_path`, `_dominant_activity`, `_path_distance_m`, det-id helper) | 0 |
| **Total new code** | **~135 LOC** |

vs. `travel_leg.py` which is 447 lines. The new deriver is slightly
smaller because bracketing is simpler (nullable, no zip-pairs) and the
path-fetch query is replaced by direct in-memory access.

---

## 6. Concrete integration sketch (recommended)

New file `runtime/app/src/scrollantir/core/derivers/movement_segments.py`
holds the `generate_movements` function from §5.2 plus the
`MovementSegment` dataclass. New file
`runtime/app/src/scrollantir/core/derivers/movement.py` holds the
deriver:

```python
# runtime/app/src/scrollantir/core/derivers/movement.py
"""movement/v1 deriver — first-class motion segments.

Segmentation algorithm ported (NOT installed) from
trackintel/preprocessing/positionfixes.py::generate_triplegs
(method='between_staypoints'). See docs/research/2026-04-30-mobility-
libraries.md for the install-vs-port analysis.
"""
from .movement_segments import MovementSegment, generate_movements
from .stay_points import (
    GPSReading, extract_stay_points, merge_brief_exits,
)
from .travel_leg import (
    _smooth_path, _path_distance_m, _ACTIVITY_WIRE_TO_KIND,
)


class MovementV1Deriver(DeterministicDeriver):
    SOURCE = "movement/v1"
    INPUTS = ("phone.location.reading",
              "phone.activity.state", "place_visit/v1")
    IDEMPOTENCY_MODE = IdempotencyMode.OVERLAP_REPLACE

    # Symmetric with brief_exit_max_gap_min in place_visit/v1; trackintel
    # default is 15. Picked 10 for consistency. TODO tune on real data.
    gap_threshold_min: float = 10.0
    bracket_attach_max_gap_min: float = 10.0
    path_accuracy_max_m: float = 75.0

    def compute(self, conn, start, end):
        # Same lookback as place_visit/v1 (4h gap-threshold * 2).
        readings = self._fetch_readings(conn, start, end, lookback_h=8)

        # Re-derive stays in-process — keeps place_visit/v1's tuning as
        # the single source of truth and avoids the §4.3-Option-A
        # multi-source-deriver lift. Alternative is fetch derived
        # place_visit/v1 rows; design doc covers both.
        stays = extract_stay_points(readings, accuracy_max_m=30.0,
            dist_threshold_m=40.0, time_threshold_min=4.0,
            gap_threshold_hours=4.0, min_points=3)
        # Re-label brief-exit-merged readings into the merged stay's
        # span so they don't emit phantom movements (design §5.4).
        merged = merge_brief_exits(stays, max_gap_min=10.0,
                                   dist_threshold_m=40.0)
        relabelled_stays = [s for (s, _) in merged]

        segments = generate_movements(
            readings, relabelled_stays,
            gap_threshold_min=self.gap_threshold_min, min_points=2)

        visits = self._fetch_visits(conn, start, end)
        rows: list[DerivedRow] = []
        for seg in segments:
            activity = self._dominant_activity(conn, seg.start_ts, seg.end_ts)
            timestamps = [_lookup_ts(readings, eid) for eid in seg.event_ids]
            path, eids, smooth_metrics = _smooth_path(
                [list(p) for p in seg.path],
                [str(e) for e in seg.event_ids],
                timestamps, activity or "walking")
            from_id, to_id = _bracket_visits(
                seg, visits, max_gap_min=self.bracket_attach_max_gap_min)
            rows.append(DerivedRow(
                id=_movement_id(from_id, to_id, seg.start_ts),
                source=self.SOURCE,
                start_ts=seg.start_ts, end_ts=seg.end_ts,
                data={
                    "from_visit_id": str(from_id) if from_id else None,
                    "to_visit_id":   str(to_id)   if to_id   else None,
                    "dominant_activity": activity or "walking",
                    "distance_m": _path_distance_m(path),
                    "reading_count": len(path),
                    "path": path,
                },
                provenance={
                    "inputs": list(self.INPUTS),
                    "source_event_ids": eids,
                    "from_visit_id": str(from_id) if from_id else None,
                    "to_visit_id": str(to_id) if to_id else None,
                },
            ))
        return rows, metrics
```

No new dependencies. Same `DeterministicDeriver` + `OVERLAP_REPLACE`
shape the rest of the system uses. Same deterministic-id contract. The
migration plan in `movement-model-design.md §6` runs unchanged.

---

## 7. Risks

**With porting (chosen):**

1. **Algorithm divergence over time.** trackintel might fix a corner
   case (e.g., trackintel issue #27's gap handling) that we miss.
   *Mitigation:* segment is small enough to re-read on each Tenet-8
   audit pass; subscribe to GitHub releases.
2. **Multi-user assumption.** trackintel's `cond_new_user` is the
   first-segment-after-user-change trigger. We elide it (single user,
   per Tenet 7). Document the assumption in the docstring.
3. **Geometry validity.** trackintel's `_drop_invalid_triplegs` removes
   self-intersecting LineStrings via shapely. We don't check — the
   spike-drop smoother already handles the multipath case that
   produces pathological paths. Self-intersection from honest
   doubling-back is signal we want to keep (Tenet 1).
4. **`gap_threshold_min` choice.** We pick 10.0 to symmetrize with
   `brief_exit_max_gap_min`; trackintel defaults to 15.0. May be wrong
   for a 12-min subway-tunnel gap. *Mitigation:* Tenet 4 — leave a
   TODO and tune on real data.
5. **`generate_locations` analog (DBSCAN to canonical Home/Work).**
   trackintel has it; we don't, because OSM matching gives real
   `place_id` strings. Non-risk for v1, flag if OSM strategy shifts.
6. **`trip/v1` later.** `generate_trips` is another ~80 lines we'd
   port if we ever add a trip entity. Defer per
   `movement-model-design.md §3.1`; same calculus applies.

**With installing trackintel anyway:**

1. **Image bloat (~250 MB).** Tenet 7.
2. **GeoDataFrame allocation per tick** for ~1k rows is wasteful at
   single-user scale.
3. **Reverse-engineering int-id ↔ event-id mapping** on every
   release — trackintel's `generate_triplegs` already carries a
   deprecation warning on the no-staypoint-id-on-pfs path; their
   internals will keep moving.
4. **Tenet 3 and Tenet 9 violations:** "prefer general systems" and
   "keep the framework simple." 250 MB to wrap 30 lines of algorithm
   is the wrong shape; library-specific glue (overlap_staypoints
   shape, GeoDataFrame columns we don't otherwise use, integer-index
   round-tripping) is the wrong abstraction.

---

## 8. Sources

### trackintel
Repo `mie-lab/trackintel` (master), fetched 2026-04-30 via `gh api`:

- `setup.py` — runtime deps. Confirmed list:
  `pandas, geopandas>=0.12.0, matplotlib, numpy, shapely, geoalchemy2,
  osmnx, scikit-learn, tqdm, similaritymeasures`.
  https://github.com/mie-lab/trackintel/blob/master/setup.py
- `trackintel/preprocessing/positionfixes.py` (25,270 bytes). Contains
  `generate_staypoints` (defaults `dist_threshold=100, time_threshold=5.0,
  gap_threshold=15.0, include_last=False, exclude_duplicate_pfs=True`),
  `_generate_staypoints_sliding_user` (sliding-window loop), and
  `generate_triplegs` (default `gap_threshold=15`). The
  `cond_new_user | cond_temporal_gap | cond_stp` boundary detection is
  the algorithmic heart cited above. Algorithmic content unchanged vs.
  PyPI 1.4.2.
  https://github.com/mie-lab/trackintel/blob/master/trackintel/preprocessing/positionfixes.py
- `trackintel/model/staypoints.py` — `Staypoints` class. Required cols
  `['user_id', 'started_at', 'finished_at']`. Provides
  `merge_staypoints(triplegs, max_time_gap='10min')`,
  `create_activity_flag(time_threshold=15.0)`, `generate_locations`.
  https://github.com/mie-lab/trackintel/blob/master/trackintel/model/staypoints.py
- `trackintel/model/triplegs.py` — `Triplegs` class. Required cols same;
  geometry MUST be LineString. **No staypoint FKs** — confirms design
  doc claim.
  https://github.com/mie-lab/trackintel/blob/master/trackintel/model/triplegs.py
- Repo metadata: pushed_at 2026-04-14, 261 stars, 24 open issues, MIT,
  master branch. Recent commits: `f7bf6fd` 2026-04-14, `87b8b50`
  2026-03-10, `2a18258` 2026-02-20, `96b6bdf` 2026-02-20.
- PyPI: trackintel 1.4.2, py3-none-any wheel 152 KiB.
- Trackintel paper: Martin et al. 2023, *Computers, Environment and
  Urban Systems* 101:101938. https://arxiv.org/pdf/2206.03593

### scikit-mobility
- Repo `scikit-mobility/scikit-mobility`, pushed_at 2024-05-25, 802
  stars, 67 open issues, BSD-3-Clause. Effectively dormant.
- `pyproject.toml` — `pandas = "^1.1.5"` (deal-breaker pin),
  `python-igraph ^0.9.1`, `powerlaw ^1.4.6`, `folium 0.12.1.post1`,
  `geojson ^2.5.0`.
- `skmob/preprocessing/detection.py::stay_locations` — defaults
  `stop_radius_factor=0.5, minutes_for_a_stop=20.0,
  spatial_radius_km=0.2, no_data_for_minutes=1e12`. Stops-only.
  https://github.com/scikit-mobility/scikit-mobility/blob/master/skmob/preprocessing/detection.py

### MovingPandas
- Repo `movingpandas/movingpandas`, pushed_at 2026-04-23, 1395 stars,
  33 open issues, BSD-3-Clause, active.
- `pyproject.toml` runtime deps: `matplotlib, geopandas, geopy`.
- `movingpandas/trajectory_stop_detector.py::TrajectoryStopDetector`
  (9540 bytes). API:
  `get_stop_time_ranges(max_diameter, min_duration)`,
  `get_stop_segments`, `get_stop_points`. Stops-only; no first-class
  tripleg/move-segment entity.
  https://github.com/movingpandas/movingpandas/blob/main/movingpandas/trajectory_stop_detector.py

### Scrollantir
- `runtime/app/pyproject.toml` — current deps: fastapi, uvicorn,
  apscheduler, psycopg, pydantic, httpx. No pandas/numpy/shapely.
- `runtime/app/Dockerfile` — `FROM python:3.12-slim`, uv-managed.
- `runtime/app/src/scrollantir/core/derivers/stay_points.py:82-159` —
  `extract_stay_points`. Returns `event_ids: tuple[UUID, ...]` per
  stay (`:62`) — load-bearing field that lets us sidestep trackintel's
  reverse-lookup pain.
- `runtime/app/src/scrollantir/core/derivers/place_visit.py:280-299` —
  `_deterministic_visit_id` (uuid5).
- `runtime/app/src/scrollantir/core/derivers/place_visit.py:302-397` —
  `_merge_same_place_long_gaps` (commit `2d24a30`, no trackintel
  counterpart).
- `runtime/app/src/scrollantir/core/derivers/travel_leg.py:340-434` —
  `_smooth_path` activity-aware spike-drop (no trackintel counterpart).
- `runtime/app/src/scrollantir/core/derivers/base.py:38-57,130-192` —
  `IdempotencyMode` and `DeterministicDeriver.run`.
- `docs/movement-model-design.md` — design doc this research validates
  from a library-vs-port angle.
- `docs/TENETS.md` — Tenets 6, 7, 9 all favor porting over installing.
