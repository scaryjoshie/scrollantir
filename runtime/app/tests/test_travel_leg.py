"""`travel_leg/v1` path smoother tests.

End-to-end pipeline tests that need a real DB are deferred to the
integration pass; these cover `_smooth_path()` directly with
synthetic readings sized to match the audit cases observed
2026-04-30 (urban-multipath spikes, sub-second duplicates).
"""

from __future__ import annotations

from datetime import timedelta

from scrollantir.core.derivers.travel_leg import _smooth_path

from .conftest import UTC, offset_meters


def _build(samples):
    """Compact builder for `_smooth_path` inputs.

    Each `samples` entry is `(north_m_from_origin, dt_seconds)`.
    Origin is Sargent (42.0571, -87.6747). Returns
    `(path, ids, timestamps)` triple matching the smoother's
    signature.
    """
    base = (42.0571, -87.6747)
    path: list[list[float]] = []
    ids: list[str] = []
    timestamps = []
    ts = UTC(2026, 4, 29, 21, 0)
    for i, (north_m, dt) in enumerate(samples):
        if i > 0:
            ts = ts + timedelta(seconds=dt)
        lat, lng = offset_meters(base, north_m=north_m, east_m=0.0)
        path.append([lng, lat])
        ids.append(str(i))
        timestamps.append(ts)
    return path, ids, timestamps


def test_smoother_passthrough_clean_walk():
    """Steady walk — no points should be dropped."""
    # 1.5 m/s walk, sample every 30s = 45m per step. All within
    # the 3.0 m/s walking ceiling.
    path, ids, ts = _build([(i * 45.0, 30.0) for i in range(8)])
    out_path, out_ids, m = _smooth_path(path, ids, ts, "walking")

    assert len(out_path) == 8
    assert out_ids == [str(i) for i in range(8)]
    assert m["smoother_dropped_dup"] == 0
    assert m["smoother_dropped_speed"] == 0


def test_smoother_drops_multipath_spike():
    """A single point 200m off the line, returning, is dropped."""
    # Walk along a clean line; insert one outlier at idx 3 that's
    # 200m off in 30s (6.67 m/s in, 6.67 m/s out — both fail the
    # 3.0 ceiling).
    samples = [
        (0.0, 30.0),
        (45.0, 30.0),
        (90.0, 30.0),
        (290.0, 30.0),   # spike: 200m jump
        (135.0, 30.0),   # back on the line
        (180.0, 30.0),
        (225.0, 30.0),
    ]
    path, ids, ts = _build(samples)
    out_path, out_ids, m = _smooth_path(path, ids, ts, "walking")

    assert "3" not in out_ids, "spike should have been dropped"
    assert len(out_path) == 6
    assert m["smoother_dropped_speed"] == 1


def test_smoother_keeps_honest_sprint():
    """Single fast-but-possible step that doesn't reverse is kept.

    A point that's fast on the way IN but the path continues in the
    same direction OUT is not a spike — it's an acceleration. The
    smoother must not drop it.
    """
    # Steady 1.5 m/s walk, then a 5 m/s burst (beyond walking
    # ceiling) but the path continues in the same direction at
    # 1.5 m/s — only A→B fails, B→C is fine.
    samples = [
        (0.0, 30.0),
        (45.0, 30.0),
        (90.0, 30.0),
        (240.0, 30.0),   # 150m jump — 5.0 m/s into B
        (285.0, 30.0),   # continues 1.5 m/s out
        (330.0, 30.0),
    ]
    path, ids, ts = _build(samples)
    out_path, out_ids, m = _smooth_path(path, ids, ts, "walking")

    # idx 3 fails A→B (5.0 > 3.0) but passes B→C (1.5 < 3.0), so
    # spike-drop preserves it.
    assert "3" in out_ids
    assert m["smoother_dropped_speed"] == 0


def test_smoother_drops_subsecond_duplicate():
    """Two readings within `_DUP_DT_S` collapse to one."""
    samples = [
        (0.0, 30.0),
        (45.0, 30.0),
        (45.5, 0.1),     # duplicate-ish, fired 0.1s after idx 1
        (90.0, 29.9),
        (135.0, 30.0),
    ]
    path, ids, ts = _build(samples)
    out_path, out_ids, m = _smooth_path(path, ids, ts, "walking")

    assert "2" not in out_ids
    assert len(out_path) == 4
    assert m["smoother_dropped_dup"] == 1
    assert m["smoother_dropped_speed"] == 0


def test_smoother_activity_aware_ceilings():
    """A 7 m/s point is a spike for walking but honest for biking."""
    # Insert a point requiring 7 m/s in/out — over walking (3.0)
    # and running (5.5) ceilings, but under bike (11.0).
    samples = [
        (0.0, 30.0),
        (45.0, 30.0),
        (255.0, 30.0),   # 7 m/s in
        (45.0, 30.0),    # 7 m/s out (back to original line)
        (90.0, 30.0),
        (135.0, 30.0),
    ]
    path, ids, ts = _build(samples)

    # Walking: drops the spike.
    _, walk_ids, walk_m = _smooth_path(path, ids, ts, "walking")
    assert "2" not in walk_ids
    assert walk_m["smoother_dropped_speed"] >= 1

    # Biking: keeps it (7 m/s is reasonable).
    _, bike_ids, bike_m = _smooth_path(path, ids, ts, "on_bicycle")
    assert "2" in bike_ids
    assert bike_m["smoother_dropped_speed"] == 0


def test_smoother_iterates_to_collapse_adjacent_spikes():
    """Two consecutive spikes both get dropped via fixed-point loop.

    First pass drops the inner spike; the now-adjacent outer spike
    becomes detectable in the next iteration.
    """
    samples = [
        (0.0, 30.0),
        (45.0, 30.0),
        (245.0, 30.0),   # spike #1
        (445.0, 30.0),   # spike #2 (different direction)
        (90.0, 30.0),    # back on line
        (135.0, 30.0),
    ]
    path, ids, ts = _build(samples)
    out_path, out_ids, m = _smooth_path(path, ids, ts, "walking")

    assert "2" not in out_ids
    assert "3" not in out_ids
    assert m["smoother_dropped_speed"] == 2


def test_smoother_handles_empty_and_short_paths():
    """Degenerate inputs return cleanly without errors."""
    # Empty.
    out, ids, m = _smooth_path([], [], [], "walking")
    assert out == [] and ids == []

    # Single point — nothing to gate.
    p, i, t = _build([(0.0, 0.0)])
    out, oids, m = _smooth_path(p, i, t, "walking")
    assert out == p and oids == i

    # Two points — no interior to gate, returned unchanged.
    p, i, t = _build([(0.0, 0.0), (45.0, 30.0)])
    out, oids, m = _smooth_path(p, i, t, "walking")
    assert out == p and oids == i


def test_smoother_endpoints_always_kept():
    """Even an endpoint that looks like a spike is preserved.

    The smoother only inspects interior points (it has no neighbor
    on one side for endpoints), so endpoints are always kept.
    Visit-anchored endpoints in particular MUST survive — they're
    what bridge the leg to its surrounding place_visit rows.
    """
    # First point is wildly off; second through fifth are clean.
    # The first point survives despite being far because there's
    # no previous neighbor to triangulate against.
    samples = [
        (1000.0, 30.0),  # wild start — kept anyway
        (0.0, 30.0),
        (45.0, 30.0),
        (90.0, 30.0),
        (135.0, 30.0),
    ]
    path, ids, ts = _build(samples)
    out_path, out_ids, m = _smooth_path(path, ids, ts, "walking")

    assert "0" in out_ids
    assert "4" in out_ids
