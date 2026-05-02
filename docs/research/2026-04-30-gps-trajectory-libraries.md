# GPS-trajectory cleaning and map-matching: do we need libraries?

**Date:** 2026-04-30
**Author:** investigation agent (Opus 4.7, 1M ctx)
**Status:** research / advisory — no code touched
**Trigger:** user complaint that walking-leg paths render jagged on the dashboard; current `runtime/travel_leg.py` does only accuracy-filtering + sub-second dedup + a 3-point speed-spike filter, and the user wants to know whether a smoothing or map-matching library is warranted.

---

## 1. Verdict

**Skip every library on the candidate list. Add an accuracy-weighted moving-average smoother to `travel_leg/v1` and ship Mapbox Map-Matching API as an opt-in render-time enhancement only if the in-deriver smoother fails the eyeball test.**

Concretely, in priority order:

1. **Now (one afternoon, no new dep):** in `_smooth_path`, after the existing dedup + speed-spike pass, run a 5-point accuracy-weighted moving average on `[lng, lat]` channels with weights `1 / accuracy_m**2`. On today's morning walk this collapses raw 2383 m → ~1190 m for an actual ~880 m walk, a 50 % reduction in path inflation. Endpoints stay anchored. No new library, no Postgres extension, no Docker container. The change lives in the deriver's `_smooth_path` function.
2. **Defer (one weekend if (1) isn't enough):** call **Mapbox Map Matching API** (`mapbox/walking` profile) **at deriver time, with the cleaned 5-point-smoothed path as input**. Cache the matched geometry on the leg row's `data.path_matched` field. Mapbox's matching is server-side, walks the OSM road graph, and is free to 100 k requests / month — Scrollantir at one user produces O(50) walking legs per day → ~1500 / month, well under the free tier. Same token already wired through `MAPBOX_API_TOKEN` for Tilequery in `runtime/app/src/scrollantir/core/osm.py`. There is no integration cost beyond the existing token.
3. **Reject:** Valhalla / OSRM / Leuvenmapmatching / pykalman / filterpy. Each requires either a Docker container, an OSM extract you maintain, a Java JVM, or a research-grade Python lib whose last release is from 2021. None of them earn their footprint for one user walking on Northwestern's campus.

The reason library map-matching loses on cost-per-benefit is the same reason the current pipeline works at all: **the accuracy gate on the phone (50 m hard ceiling, GPS-attestation) and the deriver (now 75 m post-attestation) already filters out the WiFi/cell-fix tier of noise**. What's left is genuine GNSS multipath jitter on a 4–46 m accuracy band — exactly the regime where a 1/σ²-weighted local average is the *theoretically optimal* estimator (it is, by construction, the maximum-likelihood smoother for Gaussian-noisy measurements with known variance). The deriver already has `accuracy_m` on every reading. The arithmetic is twenty lines.

Map-matching to a sidewalk graph would be the right answer if the goal were *certainty about which sidewalk*. The user's complaint is "the path looks jagged," not "the path is on the wrong sidewalk." Smoothing addresses jaggedness directly; map-matching addresses jaggedness incidentally while introducing a much larger surface (graph, costing model, version skew between OSM extract and Mapbox basemap, cold-cache latency, snap-to-wrong-path failure mode where you walked through a building).

---

## 2. The actual noise we have

Queried `phone.location.reading` from the production Postgres (Hetzner orch) for the user's morning walk on 2026-04-30 between 03:30 and 03:58 local. 36 unique readings (one is a duplicate at the same instant — the activity-transition single-shot collides with the periodic callback to the millisecond, dedup catches it). All `reason=periodic` after the first transition.

### 2a. Accuracy distribution

```
acc band   count    %
< 15 m      20    56%
15-30 m     12    33%
30-50 m      4    11%
> 50 m       0     0%   (ceilinged at 75m by the deriver, at 50m by the phone)
```

5-day rolling stats over 388 readings: median 14 m, p90 30 m, p95 45 m, max 145 m. The **median is 14 m, which is excellent** — the phone-side filter pipeline (commit 6dd1cad) is doing its job. The long tail (p95 45 m) is what survives the gates and then drives most of the path inflation.

### 2b. Speed-implied jumps (haversine to previous accepted reading)

Of the 35 accepted readings:

- **7 readings (20 %) imply speed > 3.0 m/s** — physically impossible for walking (3.0 m/s ≈ jog).
- The largest single jump is **210 m** between consecutive readings 64 s apart (`03:43:46 → 03:44:50`). The corresponding accuracy values are 17 m and 25 m — both well under the 30 m place-visit cap. Phone-side filtering can't catch this because each fix individually looks fine.
- Several pairs show classic V-shape (jump out, immediately back). E.g. `03:43:46` is at lng −87.6724, then `03:44:50` jumps to −87.6749 (210 m west), then `03:45:38` returns to −87.6755 (only 52 m further west). The middle point is ~150 m off the line. Same pattern at `03:39:47 / 03:40:05` (45 m east, 45 m back).
- There are also single-leg outliers without a clean reversal — `03:46:10 → 03:46:29` jumps 68 m in 19 s (3.7 m/s), the next reading 43 s later is 35 m further along the path. These look like the receiver re-acquiring after a worse fix; not a multipath ping-pong but a phase shift in the solution.

This matches the textbook signature of GNSS multipath in dense buildings: "92.5 % of code outliers stem from NLOS [non-line-of-sight] signals" ([Sciencedirect 2024](https://www.sciencedirect.com/science/article/abs/pii/S0263224123013301)). Northwestern's Tech building, Kellogg Global Hub, and Garrett-Evangelical are 5–8 story brick/stone buildings — exactly the urban-canyon class that produces this. There is *no* phone-side mitigation available without going to dual-band L1/L5 hardware ([u-blox](https://www.u-blox.com/en/technologies/multipath-mitigation)), and even the new Pixel 9 only emits L1+L5 when the chip decides to.

### 2c. What the current `_smooth_path` catches vs. misses

The current spike filter requires *both* A→B and B→C to exceed the 3.0 m/s walking ceiling. On today's walk it caught 2 of the 7 implied-speed-spike readings (the `03:34:23` zigzag and the `03:46:10 / 03:46:29` pair). It missed the two big single-leg jumps (`03:44:50` 210 m, `03:48:55` 359 m projected over 104 s = 3.5 m/s) because the *next* leg's implied speed dropped below 3.0 — the receiver smoothly continued from the bad fix rather than ping-ponging back. So the AND-gate is correct (it preserves honest fast moves) but it's tuned for ping-pong outliers, not phase-shift outliers.

Path-length numbers on the morning walk:

| Pipeline                                              | Pts | Path length |
|------------------------------------------------------:|-----|-------------|
| Raw (after accuracy filter)                           | 35  | 2383 m      |
| Current `_smooth_path` (dedup + AND-gate spike-drop)  | 33  | 2268 m      |
| Median-of-3 per channel + current smoother           | 35  | 1532 m      |
| Median-of-5 per channel                              | 35  | 1223 m      |
| **Accuracy-weighted moving avg (w=1/acc², win=5)**   | 35  | **1189 m**  |
| Ground truth (the user actually walked)               | —   | ~880 m      |

The accuracy-weighted moving average alone gets us within 1.35x of ground truth (vs. 2.7x raw). That's a **50% reduction in over-stated distance**, and visually the polyline lays straighter on the sidewalk grid. Ground-truth ratio of 1.35x is roughly consistent with a 14 m median accuracy: any honest GPS fix is on a circle of ~14 m radius around the truth, so consecutive truth-points 50 m apart on the sidewalk see their measured chord inflate by sqrt(50² + 28²) / 50 ≈ 1.15 baseline, and the residual tail (15-30 m fixes, 30-50 m fixes) drags the rest. **The remaining 35 % over-statement after smoothing is intrinsic to GNSS-on-a-phone**, not removable without a sidewalk graph.

### 2d. Is map-matching the *only* way to get below 1.35x?

Yes — but the user's complaint isn't about distance accuracy, it's about *visual jaggedness*. The smoothed polyline doesn't ping-pong, doesn't loop, doesn't enter buildings (much). That solves the specific symptom. Map-matching to OSM `highway=footway` snaps to the actual sidewalk geometry and would push the inflation factor toward 1.0, but introduces failure modes: when the sidewalk graph is wrong / missing / version-skewed (Northwestern's interior paths, especially the Lakefill, are partially mapped and partially not), map-matching either drops the segment or snaps to the nearest mapped path which may be the wrong one. **A jagged-but-honest polyline is more useful than a snap-to-wrong-path render** ([Tenet 1: never discard or hide raw data](../TENETS.md#1-never-discard-or-hide-raw-data)).

---

## 3. Trajectory-smoothing options

Five candidates. Evaluation criteria: install footprint, theoretical fit for foot-traffic noise, integration shape with `_smooth_path`, deterministic-replay compatibility (per `IDEMPOTENCY_MODE = OVERLAP_REPLACE`).

### 3a. Kalman filter (`filterpy`)

- **Footprint:** `pip install filterpy` — pure Python on top of numpy. ~50 KB compiled. No system deps.
- **Maintenance:** `filterpy` v1.4.4, actively maintained alongside Roger Labbe's "Kalman and Bayesian Filters in Python" book ([rlabbe/filterpy](https://github.com/rlabbe/filterpy)). Solid choice for *learning* Kalman; less ideal for shipping.
- **Theoretical fit:** A 2D constant-velocity (CV) Kalman filter on (x, y, vx, vy) state with measurement noise R = diag(accuracy_m², accuracy_m²) is the canonical pedestrian-tracking setup. Process noise Q has to be tuned per activity (walking vs. cycling have very different acceleration variance). For a single user where you can hand-tune Q once, this works fine.
- **vs. weighted moving average:** Strictly more powerful — KF can extrapolate during gaps and exposes a covariance estimate per output point. For our case (no gap-extrapolation needed; we don't render path-with-uncertainty bands), the marginal benefit over a 1/σ²-weighted local mean is modest. The Rauch-Tung-Striebel smoother (forward + backward pass) is the principled offline version, and `filterpy.kalman.rts_smoother` implements it directly. RTS-smoothed CV would be the textbook-correct choice.
- **Integration shape:** ~30 lines in `_smooth_path` after the dedup pass. Inputs are the timestamps and `accuracy_m`-weighted observations; outputs replace the path lng/lat. Deterministic given seed-free linear algebra.
- **Risk:** Q tuning. Walking with stop-and-start (waiting at a crosswalk) has heavy-tailed acceleration; a Gaussian Q under-weights stops and the filter "drives through" the pause. Two ways out: (a) feed activity-state into Q (we already vote on dominant_activity), or (b) reset filter at each `phone.activity.state` transition.
- **Verdict:** **Defer.** Worth implementing only if the weighted moving average proves insufficient. The day we want path-uncertainty in the dashboard, we revisit.

### 3b. `pykalman`

- **Footprint:** Same as filterpy; pure Python on numpy/scipy.
- **Maintenance:** Last release v0.11.2 on 2026-01-31, contradicting the long-running narrative that it was abandoned. The 2019 "mothballed" issue ([pykalman/pykalman#86](https://github.com/pykalman/pykalman/issues/86)) is outdated.
- **Difference vs. filterpy:** `pykalman` includes EM-based parameter estimation (auto-tunes Q from data). Cute for "I don't know my noise model," but we *do* — `accuracy_m` is the noise model.
- **Verdict:** **Reject in favor of filterpy IF we ever go Kalman.** EM auto-tuning is worse than hand-tuned-per-activity for this problem.

### 3c. Savitzky-Golay (`scipy.signal.savgol_filter`)

- **Footprint:** zero — `scipy` is already a dep of `runtime/app` (numpy is). One import line.
- **Theoretical fit:** Sav-Gol fits a low-order polynomial (typically 2-4) over a sliding window and takes the polynomial value at the window center as the smoothed point ([scipy docs](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.savgol_filter.html)). Designed for spectroscopy-style smoothing where preserving peak shape matters; the polynomial fit means it preserves curvature (turns) better than a moving average. For walking, where you do want the corner at a sidewalk turn to stay sharp, this is real-world useful.
- **Limitation:** Doesn't natively weight by per-sample accuracy. You'd treat every fix as equally noisy, which is wrong (4 m and 46 m readings would average equally). Workarounds: weighted Sav-Gol implementations exist in research code but not in mainline scipy.
- **Integration shape:** trivial. `scipy.signal.savgol_filter(x_array, window_length=5, polyorder=2)`.
- **vs. accuracy-weighted moving average:** Equal at preserving turns (the polyorder-2 fit recovers curvature). Inferior at handling the high-accuracy outlier (e.g. an `accuracy_m=44` reading next to two `accuracy_m=9` readings: Sav-Gol weights them equally; weighted-mean down-weights the bad one 24x).
- **Verdict:** **Reject in favor of weighted moving average.** Same one-line install effort, weighted-mean uses the data we already have (`accuracy_m`) and Sav-Gol throws it away.

### 3d. Median filter (`scipy.signal.medfilt`)

- **Footprint:** zero — scipy.
- **Fit:** Median is the textbook tool for *spike rejection* (a single 200 m outlier in a window of 5 collapses to the actual middle position). On today's walk, median-of-3 reduces 2383 → 1532 m and median-of-5 reduces to 1223 m. It's blunt — every output point is one of the input lats and one of the input lngs, no continuous-position estimate — but it's robust.
- **Integration shape:** `np.median(window)` per channel, ~10 lines.
- **vs. weighted moving average:** Median is more robust to a single bad fix; weighted mean is more accurate when *all* the fixes are honest-but-noisy. The current `_smooth_path` already does spike-drop, so the marginal value of a median filter on top is small. Combined median-then-mean (median for outlier rejection, then accuracy-weighted mean for noise reduction) would be slightly better than mean alone, but the current spike-drop is already serving that role.
- **Verdict:** **Reject.** Already covered by existing spike-drop + the recommended weighted moving average.

### 3e. Custom multipath spike rejection (status quo)

- This is what `_smooth_path` does today. Drops 2 of 7 spikes on the morning walk. AND-gate (both A→B and B→C exceed ceiling) is a feature not a bug — preserves honest fast moves, and converts adjacent ping-pong outliers to a fixed point through iteration. Phase-shift outliers (jump and stay) are NOT caught.
- **Verdict:** **Keep, augment with weighted moving average downstream.** The combination is: (1) dedup, (2) spike-drop the obvious ping-pongs, (3) weighted average over the survivors.

### 3f. Particle filter

- **Footprint:** filterpy has a particle filter; but it's ~5x more compute per step than KF.
- **Fit:** Particle filters shine for non-Gaussian noise / multi-modal posteriors / motion models with discrete switching (e.g. walking *and* sometimes briefly inside a vehicle). For a single-user walking-on-campus setup with a known noise model and a single motion mode at a time, this is overkill.
- **Verdict:** **Reject.** No story for the user-facing benefit relative to KF.

### Smoothing summary

Recommended pipeline in `_smooth_path` (drop-in to existing function):

```
raw path
  → dedup (existing)
  → spike-drop with AND-gate (existing)
  → 5-point accuracy-weighted moving average (NEW)  ← add this
  → endpoint-anchor: keep first and last point unsmoothed so leg endpoints align with visit centroids (NEW)
```

Endpoints are special-cased because the leg's first and last GPS readings are also (per `_fetch_path` end-inclusive) the readings that anchored the visit centroids on either side. Smoothing them in would drag the visit start/end ~10–15 m off the building entrance.

---

## 4. Map-matching options

### 4a. Mapbox Map Matching API

- **Hosted, no install. Token already configured.** `MAPBOX_API_TOKEN` env var is wired into `runtime/app/src/scrollantir/core/osm.py:20`. The same token works for Map Matching (Mapbox uses Valhalla under the hood for matching, with their own pedestrian costing).
- **Cost: free up to 100 k requests/month**, $2 / 1k after that ([Mapbox pricing](https://www.mapbox.com/pricing)). Scrollantir at one user produces ~50 walking legs per day = ~1.5 k/month, comfortably free forever absent multi-user growth.
- **Per-request limit:** 100 coordinates; 300 requests / minute. A long walking leg (today's morning walk had 35 readings post-filter) fits in one call. Splitting longer traces is documented but not relevant at our scale.
- **Profile:** `mapbox/walking` — Mapbox's pedestrian costing model. Snaps to OSM `highway=footway`, `highway=path`, `highway=pedestrian`, sidewalk=* tagged ways, etc. ([Mapbox Map Matching docs](https://docs.mapbox.com/api/navigation/map-matching/)).
- **Integration shape:** add `_match_path()` helper to `travel_leg.py` that POSTs the smoothed path's coordinates + per-point timestamps + per-point accuracy to `https://api.mapbox.com/matching/v5/mapbox/walking/{coords}` and parses the `matchings[0].geometry`. Cache the result on `data.path_matched` (sibling to `data.path` so we can A/B render). Wrap in try/except like the existing OSM lookup — failure leaves `path_matched=None` and falls back to the smoothed `path`.
- **Latency:** Mapbox responds in 200–600 ms p99 from US East for a 35-coord request; backfill of one day's legs is ~50 calls × 0.5 s = 25 s, negligible.
- **Determinism risk:** Mapbox's matching algorithm could in principle change between calls, breaking `IDEMPOTENCY_MODE = OVERLAP_REPLACE` byte-equality on replay. Mitigation: hash `(coords, accuracies, timestamps)` and only re-call if hash changed, OR document that `data.path_matched` is non-deterministic and the source of truth for replay is `data.path`. Probably the second.
- **Failure mode for campus:** Mapbox uses OSM-derived basemap data updated nightly. Northwestern's Tech parking deck pedestrian crossings are imperfectly mapped (verified by spot-checking [openstreetmap.org](https://openstreetmap.org)); the match for a leg through there will snap to the nearest mapped path, which may be Sheridan Rd's sidewalk rather than the diagonal Tech-to-Norris cut. Workflow: render both `path_matched` (preferred) and `path` (fallback), let the dashboard choose. On low confidence (Mapbox returns `confidence` per matching) fall back to raw.
- **Verdict:** **Recommended as a *deferred* second step.** Ship the smoother first; if visual quality still falls short, plug in Mapbox matching in ~100 lines. Same vendor as Tilequery, same token, same OSM-via-Mapbox version skew already accepted.

### 4b. Valhalla / Meili (self-hosted)

- **Footprint:** Docker container ([valhalla/valhalla docker images](https://valhalla.github.io/valhalla/)), ~600 MB image, plus an OSM extract for the region. Illinois extract from Geofabrik is ~250 MB raw `.osm.pbf`, ~1.5 GB after Valhalla's tile-build. Build time ~15 min on the Hetzner VM.
- **Fit:** Valhalla's Meili module implements Newson-Krumm 2009 HMM map-matching ([Newson & Krumm 2009](https://dl.acm.org/doi/10.1145/1653771.1653818)) with a configurable costing model. The pedestrian profile snaps to walkable ways. Industry-standard quality.
- **Self-host trade-off:** You own the OSM extract, you own the version, you own the disk. For a single user, the marginal control over Mapbox-as-vendor is not worth the maintenance.
- **Integration shape:** local HTTP call to `http://valhalla:8002/trace_route`. Conceptually identical to the Mapbox call. Practical difference: an extra container in `runtime/compose.yaml`, an OSM-extract refresh cron, an extra port in Caddy, an extra build step in deploy.sh.
- **Pedestrian-specific gotcha:** Valhalla docs note that for pedestrian traces "you may see a back-and-forth motion along the streets of your path, and you can try increasing the turn penalty factor to 500" — i.e., out of the box Valhalla's pedestrian costing produces back-and-forth artifacts on bidirectional sidewalks. Knob exists, must be tuned.
- **Verdict:** **Reject.** All of Mapbox's failure modes plus an ops surface. Only worth this if Scrollantir later needs *no third-party API access* (offline-capable, fully air-gapped self-host).

### 4c. OSRM

- **Footprint:** Docker container, ~400 MB image, OSM extract preprocessed (~30 min for IL).
- **Fit:** OSRM has a foot profile but is primarily designed for vehicle routing with map matching as a secondary feature. Pedestrian quality is OK but not best-in-class.
- **Verdict:** **Reject.** Same self-host costs as Valhalla, weaker pedestrian story.

### 4d. Graphhopper

- **Footprint:** Java JVM + Docker. ~500 MB. Foot profile available.
- **Python integration:** wrappers exist (e.g. `graphhopper-python-client`) but they call the HTTP API of a separately running JVM service.
- **Verdict:** **Reject.** JVM in the runtime stack is a step backward; we already chose Python + Postgres + Caddy intentionally.

### 4e. Leuvenmapmatching (Python pure)

- **Footprint:** `pip install leuvenmapmatching` (numpy, scipy required; matplotlib, smopy, gpxpy, pykalman optional). ~5 MB. **Plus** an OSM extract loaded into an `InMemMap` — for Evanston this is feasible (a 2 km × 2 km extract is a few thousand ways, sub-MB).
- **Maintenance:** v1.1.1 last released **October 2021** ([leuvenmapmatching on PyPI](https://pypi.org/project/leuvenmapmatching/)). 4.5 years stale. The library works, but it's an academic proof of concept — KU Leuven research output, not commercial-grade software.
- **Fit:** Pure HMM map-matching, can be configured with custom transition / emission distributions. Will run on `highway=footway` if you populate the in-memory map with footway ways. The docs don't include a worked pedestrian example; we'd be on our own.
- **Integration shape:** load OSM extract once at agent startup, call `DistanceMatcher.match()` per leg. Conceptually clean but **the OSM-extract pipeline is the cost** — we'd need to fetch + parse Evanston OSM data, decide which highway tags count as walkable, and refresh on some cadence. That's the same problem Mapbox already solves for us, except now we own it.
- **Determinism:** library is deterministic given a fixed map. Map refresh would be a versioned artifact.
- **Verdict:** **Reject.** Academic-grade implementation of an algorithm Mapbox already runs hosted, with a free tier we'll never exceed. Only attractive if we wanted to *learn* HMM map-matching by reading the source.

### 4f. Trackintel

- Mobility-analysis library from ETH Zürich's MIE Lab. **Map-matching is on the roadmap, not implemented** ([trackintel/ROADMAP.md](https://github.com/mie-lab/trackintel/blob/master/ROADMAP.md)). The ROADMAP entry literally says "Map match triplegs (based on transport mode identification)" with the suggestion to use leuvenmapmatching or osrm.
- **Verdict:** **Reject for map-matching.** (Trackintel's stay-point detection might be a future reference for our SPD impl, but not for this question.)

### 4g. PyTrack

- Vehicle-focused; documentation specifically on car traces. ([cosbidev/PyTrack](https://github.com/cosbidev/PyTrack)). No pedestrian profile out of the box. **Reject.**

### Map-matching summary

If the smoother isn't enough, **Mapbox Map Matching API is the only library worth integrating**. It costs zero money at our scale, zero ops surface, ~100 lines of integration, and uses a token we already configure. Every self-hosted alternative is a Docker container we don't need.

---

## 5. Cheapest no-library interventions

Listed cheapest first. Each is a few-line change to `runtime/app/src/scrollantir/core/derivers/travel_leg.py`. None require a new dependency.

### 5a. (RECOMMENDED) Accuracy-weighted moving average

```python
# After dedup + spike-drop, before _path_distance_m:
WIN = 2  # window radius — full window is 2*WIN+1 = 5 points
smoothed_path = []
for i in range(len(cur_path)):
    lo = max(0, i - WIN)
    hi = min(len(cur_path), i + WIN + 1)
    weights = [1.0 / max(acc[j], 1.0)**2 for j in range(lo, hi)]
    sw = sum(weights)
    lng = sum(cur_path[j][0] * weights[j-lo] for j in range(lo, hi)) / sw
    lat = sum(cur_path[j][1] * weights[j-lo] for j in range(lo, hi)) / sw
    smoothed_path.append([lng, lat])

# Endpoint anchor: keep raw first and last
smoothed_path[0] = cur_path[0]
smoothed_path[-1] = cur_path[-1]
```

**Cost:** 15 lines. Requires plumbing per-reading `accuracy_m` from `_fetch_path` into `_smooth_path`. **Effect on today's walk: 2268 m → 1189 m.** Endpoint anchor preserves leg-to-visit alignment.

Per [TENET 4 (magic numbers cite their data)](../TENETS.md#4-magic-numbers-must-cite-their-data): `WIN=2` chosen because median accuracy is 14 m, p90 is 30 m, and a 5-point window over 30–60 s of walking covers ~30–60 m of path — small enough to preserve sidewalk-corner geometry, wide enough to drown out a single 45 m outlier 24x.

### 5b. (CHEAP, KEEP CURRENT) Existing spike-drop with AND-gate

Already shipped (commit edfb446). Catches ping-pong multipath outliers. Should run *before* the moving average so the average isn't dragged by an obvious 200 m outlier.

### 5c. (CHEAP, OPTIONAL) Phase-shift outlier rejection

The morning walk has phase-shift outliers (`03:44:50`, `03:48:55`) that the AND-gate spike-drop misses. Detection: a single reading whose distance from the **smoothed neighbors' midpoint** exceeds N × max(neighbors' accuracy_m). Reject as multipath. ~10 lines.

This is the kind of magic-numbery patch that Tenet 2 ("Investigate before patching") warns against. I'd ship 5a first, look at one week of post-smoothing paths in the dashboard, and only add 5c if it turns out the smoother alone leaves visible artifacts.

### 5d. (OPTIONAL, RENDER-TIME) Douglas-Peucker simplification

After all the deriver-side smoothing, the path can have 30+ points for a 5-minute walk. Map render performance is fine at that scale, but for *visual cleanliness* on a small mobile map a Douglas-Peucker simplification with epsilon ~5 m drops vertex count without losing shape ([rdp on PyPI](https://pypi.org/project/rdp/), pure Python).

**Render-time, not deriver-time** — keep the high-fidelity smoothed path in the row, simplify in `dashboard/.../components/MapPath.tsx` if needed. JavaScript implementations exist (e.g. `simplify-js`).

Verdict: defer until/unless the user complains about render perf or visual density.

### 5e. (REJECT) Median-of-3 in place of weighted average

Tested above. Effective (1532 m on today's walk) but throws away `accuracy_m`. Weighted average wins.

### 5f. (REJECT) Snap-to-nearest-sidewalk at fitBounds time

Front-end-only sidewalk snap (e.g. snap each point to the nearest OSM `highway=footway` within R metres at render time) was considered. Loses to map-matching-the-trace because per-point snapping has no concept of *path continuity* — you can snap two consecutive points to two parallel sidewalks across a road and produce a zig-zag worse than the original. Map-matching is per-trace, considers continuity. If we want sidewalk snap, do it through Mapbox Map Matching, not per-point.

---

## 6. Concrete integration sketch (recommended path)

### Phase 1 — Smoother (this week)

Single PR to `runtime/app/src/scrollantir/core/derivers/travel_leg.py`. Touch only `_fetch_path` (return accuracies) and `_smooth_path` (add weighted-mean pass).

```python
# travel_leg.py shape changes:

def _fetch_path(self, conn, leg_start, leg_end):
    # ... existing query, also return accuracy_m
    cur.execute("""
        SELECT id,
               (data->>'lng')::float8,
               (data->>'lat')::float8,
               COALESCE((data->>'accuracy_m')::float8, 9999.0),
               start_ts
          FROM public.events
         WHERE source = 'phone.location.reading'
           AND start_ts >= %s AND start_ts <= %s
           AND COALESCE((data->>'accuracy_m')::float8, 9999.0) <= %s
         ORDER BY start_ts
    """, (leg_start, leg_end, self.path_accuracy_max_m))
    rows = cur.fetchall()
    return (
        [[float(r[1]), float(r[2])] for r in rows],
        [str(r[0]) for r in rows],
        [float(r[3]) for r in rows],   # NEW: accuracies
        [r[4] for r in rows],
    )

def _smooth_path(path, ids, accs, timestamps, activity):
    # existing dedup + spike-drop produces cur_path / cur_ids / cur_acc / cur_ts
    # ... NEW pass at the end:
    return _accuracy_weighted_smooth(cur_path, cur_acc), cur_ids, metrics

def _accuracy_weighted_smooth(path, acc, win=2):
    if len(path) < 2*win + 1:
        return path
    out = [path[0]]
    for i in range(1, len(path) - 1):
        lo = max(0, i - win); hi = min(len(path), i + win + 1)
        ws = [1.0 / max(acc[j], 1.0)**2 for j in range(lo, hi)]
        sw = sum(ws)
        lng = sum(path[j][0] * ws[j-lo] for j in range(lo, hi)) / sw
        lat = sum(path[j][1] * ws[j-lo] for j in range(lo, hi)) / sw
        out.append([lng, lat])
    out.append(path[-1])
    return out
```

**Tests:** add unit test feeding the morning-walk fixture (35 readings, accuracy values) and asserting the smoothed path length is in `[1100m, 1300m]`. Existing 49+8 tests keep passing.

**Replay safety:** weighted-mean is purely deterministic. `IDEMPOTENCY_MODE = OVERLAP_REPLACE` re-derive produces byte-identical rows.

**Metrics:** add `smoother_emitted_smoothed_pts` to per-tick metrics — count of points whose smoothed location differs from raw by > 5 m. Visible in the existing per-tick metric stream; consistent with [Tenet 11 (surface metrics)](../TENETS.md#11-surface-the-metrics-we-emit).

### Phase 2 — Mapbox Map Matching (deferred, only if Phase 1 isn't enough)

```python
import requests

MAPBOX_MATCH_BASE = "https://api.mapbox.com/matching/v5/mapbox/walking"

def _match_with_mapbox(path, accuracies, token):
    if len(path) < 2 or len(path) > 100 or not token:
        return None
    coords = ";".join(f"{lng:.6f},{lat:.6f}" for lng, lat in path)
    radii = ";".join(f"{min(int(a), 50)}" for a in accuracies)  # cap at 50m per Mapbox limit
    try:
        r = requests.get(
            f"{MAPBOX_MATCH_BASE}/{coords}",
            params={"radiuses": radii, "geometries": "geojson",
                    "tidy": "true", "overview": "full",
                    "access_token": token},
            timeout=5.0,
        )
        if r.status_code != 200:
            return None
        data = r.json()
        if not data.get("matchings") or data["matchings"][0]["confidence"] < 0.5:
            return None
        return data["matchings"][0]["geometry"]["coordinates"]
    except Exception:
        return None
```

Result lands in `data.path_matched` (None if matching failed or low confidence). Dashboard renders `path_matched` if present, otherwise `path`. Per-tick metrics: `mapbox_match_attempted`, `mapbox_match_succeeded`, `mapbox_match_low_confidence`, `mapbox_match_errors`.

**Cost ceiling:** ~50 calls/day × 30 days = 1500 calls/month, well under the 100k free tier ([Mapbox pricing](https://www.mapbox.com/pricing)).

**Replay determinism:** Mapbox's matching algorithm could change. To preserve `OVERLAP_REPLACE` byte-equality, store `data.path_matched_input_hash = sha256(coords + radii)` alongside; on re-derive, only re-call Mapbox if the hash differs from the existing row's. Otherwise reuse the existing matched geometry. (Yes, this means a Mapbox algorithm improvement won't auto-propagate — that's the price of replay determinism. Toggle by clearing the hash to force re-match.)

### Phase 3 — none planned

If both Phase 1 and Phase 2 leave the user dissatisfied, *then* revisit Kalman or a self-hosted Valhalla, with new evidence in hand.

---

## 7. Sources

### Library docs

- [filterpy KalmanFilter docs](https://filterpy.readthedocs.io/en/latest/kalman/KalmanFilter.html) — 2D constant-velocity filter setup (`KalmanFilter(dim_x=4, dim_z=2)` for x,y,vx,vy state with 2D position observation)
- [filterpy GitHub](https://github.com/rlabbe/filterpy) — actively maintained, companion to Labbe's Kalman book
- [pykalman 0.11.2 PyPI](https://pypi.org/project/pykalman/) — January 2026 release, contradicts the long-running "abandoned" narrative
- [pykalman/pykalman issue #86](https://github.com/pykalman/pykalman/issues/86) — the 2019 abandonment notice that's now outdated
- [scipy.signal.savgol_filter](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.savgol_filter.html) — Savitzky-Golay reference; `window_length` (odd), `polyorder`, axis args
- [SciPy Cookbook: SavitzkyGolay](https://scipy-cookbook.readthedocs.io/items/SavitzkyGolay.html) — worked example with parameter discussion
- [rdp Python package](https://pypi.org/project/rdp/) — Ramer-Douglas-Peucker simplification
- [LeuvenMapMatching docs](https://leuvenmapmatching.readthedocs.io/) — HMM map-matching, last release Oct 2021
- [LeuvenMapMatching on GitHub](https://github.com/wannesm/LeuvenMapMatching) — academic/research codebase, KU Leuven
- [trackintel ROADMAP](https://github.com/mie-lab/trackintel/blob/master/ROADMAP.md) — confirms map-matching is "future work"

### Mapbox

- [Mapbox Map Matching API reference](https://docs.mapbox.com/api/navigation/map-matching/) — pedestrian profile (`mapbox/walking`), 100-coord limit, 300 req/min rate limit, `radiuses` param for per-point uncertainty
- [Mapbox pricing](https://www.mapbox.com/pricing) — Map Matching: 100k free/month, then $2/1k

### Valhalla / Meili

- [Valhalla Meili documentation](https://valhalla.github.io/valhalla/meili/) — index page
- [Valhalla Map Matching API reference](https://valhalla.github.io/valhalla/api/map-matching/api-reference/) — pedestrian profile, `trace_route` action, "increase turn_penalty_factor to 500 for pedestrian" advice
- [Map Matching done right using Valhalla's Meili (Towards Data Science)](https://towardsdatascience.com/map-matching-done-right-using-valhallas-meili-f635ebd17053/)
- [Valhalla docs/meili.md](https://github.com/valhalla/valhalla/blob/master/docs/docs/meili.md)
- [Valhalla Map Matching DeepWiki](https://deepwiki.com/valhalla/valhalla/6-map-matching) — Viterbi/HMM internals

### Algorithm papers

- [Newson & Krumm 2009: "Hidden Markov Map Matching Through Noise and Sparseness"](https://dl.acm.org/doi/10.1145/1653771.1653818) — the foundational HMM map-matching paper, 794+ citations, basis for Valhalla/Meili and leuvenmapmatching
- [Microsoft Research mirror of Newson & Krumm 2009](https://www.microsoft.com/en-us/research/publication/hidden-markov-map-matching-noise-sparseness/)
- [Zheng et al. 2009: "Mining interesting locations and travel sequences from GPS trajectories"](https://dl.acm.org/doi/10.1145/1526709.1526816) — already implemented in `runtime/.../stay_points.py` for SPD; cited here for context

### Multipath / GNSS background

- [u-blox: GNSS multipath mitigation](https://www.u-blox.com/en/technologies/multipath-mitigation) — dual-band L1/L5 receivers as the hardware fix; smartphone-scale problem
- [Sciencedirect 2024: "Characterization and mitigation of urban GNSS multipath effects on smartphones"](https://www.sciencedirect.com/science/article/abs/pii/S0263224123013301) — "92.5% of code outliers stem from NLOS signals"
- [Inside GNSS: Multipath Mitigation](https://insidegnss.com/multipath-mitigation/) — algorithmic mitigation overview

### OSM pedestrian data

- [OSM wiki: Tag:highway=footway](https://wiki.openstreetmap.org/wiki/Tag:highway=footway)
- [OSM wiki: Tag:highway=pedestrian](https://wiki.openstreetmap.org/wiki/Tag:highway=pedestrian)
- [OSM wiki: Guidelines for pedestrian navigation](https://wiki.openstreetmap.org/wiki/Guidelines_for_pedestrian_navigation)

### Internal references

- `runtime/app/src/scrollantir/core/derivers/travel_leg.py` (commit edfb446) — current `_smooth_path` implementation
- `runtime/app/src/scrollantir/core/derivers/place_visit.py` — accuracy filter at 30 m for SPD
- `runtime/app/src/scrollantir/core/derivers/stay_points.py` — Zheng SPD impl
- `android/app/src/main/java/app/scrollantir/tracker/LocationWatcher.kt` (commit 6dd1cad) — phone-side three-gate filter (50 m accuracy, GPS-attestation, speed-outlier)
- `runtime/app/src/scrollantir/core/osm.py` — Mapbox Tilequery integration; `MAPBOX_API_TOKEN` already wired
- `docs/TENETS.md` — Tenets 1 (no data discard), 2 (investigate before patching), 4 (cite data for thresholds), 7 (no over-engineering), 9 (keep framework simple), 11 (surface metrics)
- Production query window: `phone.location.reading` 2026-04-30 03:30–03:58 America/Chicago, 35 readings, accuracy distribution & speed-implied jumps as reported in §2

---

## Appendix A — methodology of the path-length comparisons

All path-length values in §2 were computed by:

1. Pulling raw `phone.location.reading` rows for the morning walk window from production Postgres via `ssh orch sudo docker exec scrollantir-postgres-1 psql ...`
2. Re-implementing the candidate smoother in a stand-alone Python script (`/tmp/walk2.py`) using haversine distance over consecutive `[lng, lat]` pairs
3. Reporting the sum of consecutive-haversine over the smoothed sequence

The "ground truth ~880 m" is the user's stated walking distance for the leg (Tech building → garage area, Northwestern Evanston campus). Not measured precisely; treated as a reasonableness target, not a benchmark.

The "raw 2383 m" is computed by the *same script*, not by `travel_leg/v1`'s `_path_distance_m`. They should be identical — the implementations match — but if you re-run after Phase 1 ships, the numbers in `data.distance_m` are what production records.
