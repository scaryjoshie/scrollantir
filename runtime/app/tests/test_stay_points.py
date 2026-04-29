"""Stay-Point Detection unit tests.

Three SPD-level edge cases from the place_visit/v1 plan:

  a. Norris walking-still flips → one stay, no split
  b. One-second 120m spike (with bad accuracy) → filtered, single stay
  c. Indoor drift 45m around Sargent → centroid stable, no oscillation

Pipeline-level tests (d–j: matching, hysteresis, replay, OSM
failure) live with the place_visit deriver in commit 4 since they
need the full pipeline.
"""

from __future__ import annotations

from scrollantir.core.derivers.stay_points import (
    extract_stay_points,
    haversine_m,
)

from .conftest import (
    NORRIS,
    SARGENT,
    UTC,
    constant_dwell,
    offset_meters,
    stream,
)


def test_a_norris_walking_still_flips_one_stay() -> None:
    """Within Norris, the user moves around (~30m walks) and stops.
    Activity state would flip walking↔still many times, but SPD only
    sees GPS — and all readings stay within 30m of Norris centroid.
    Result: one stay covering the full duration."""
    start = UTC(2026, 4, 29, 14, 0)

    # 90 minutes inside Norris with deterministic jitter that walks
    # short distances back and forth (max ~12m from anchor each way).
    readings = constant_dwell(
        NORRIS,
        start=start,
        duration_minutes=90,
        sample_period_s=30.0,
        accuracy_m=12.0,
        jitter_m=15.0,
    )

    stays = extract_stay_points(readings)

    assert len(stays) == 1, f"expected 1 stay, got {len(stays)}: {stays}"
    stay = stays[0]
    # Centroid should be very close to Norris (within ~10m).
    centroid_offset = haversine_m(
        stay.centroid_lat, stay.centroid_lng, NORRIS[0], NORRIS[1]
    )
    assert centroid_offset < 10, f"centroid drifted {centroid_offset:.1f}m from Norris"
    # Dwell should be ~90 min (allow for sampling).
    assert 88 * 60 <= stay.dwell_s <= 92 * 60


def test_b_high_accuracy_filter_drops_spike_reading() -> None:
    """A single reading 120m away with bad accuracy_m=80 should be
    dropped by the accuracy filter (default 30) before SPD sees it,
    so the stay continues uninterrupted as one.

    Real-world spikes correlate with bad accuracy; the accuracy
    filter is what handles them. (The Hampel speed-spike filter is
    deferred — accuracy alone suffices for v0.)
    """
    start = UTC(2026, 4, 29, 14, 0)

    # 30 min within Norris, then a single bad-accuracy spike 120m
    # east, then 30 more min within Norris. With the default
    # accuracy_max_m=30, the spike never reaches SPD.
    pre = constant_dwell(NORRIS, start=start, duration_minutes=30)
    spike_coord = offset_meters(NORRIS, east_m=120.0)
    spike = stream(
        start=pre[-1].ts,
        samples=[
            (spike_coord, 80.0, 1.0),  # 1s after pre, accuracy=80m → dropped
        ],
    )
    post = constant_dwell(
        NORRIS,
        start=spike[-1].ts,
        duration_minutes=30,
        sample_period_s=30.0,
    )

    readings = pre + spike + post
    stays = extract_stay_points(readings)

    # The spike is filtered → SPD sees one continuous run.
    assert len(stays) == 1, f"expected 1 stay (spike filtered), got {len(stays)}"
    # Centroid stays near Norris despite the spike.
    centroid_offset = haversine_m(
        stays[0].centroid_lat, stays[0].centroid_lng, NORRIS[0], NORRIS[1]
    )
    assert centroid_offset < 15, f"centroid drifted {centroid_offset:.1f}m"


def test_c_indoor_drift_centroid_stable() -> None:
    """Inside Sargent, real drift can be ~30-45m even while the user
    sits still. Readings near the accuracy threshold get kept; the
    weighted centroid (1/accuracy) keeps the answer pinned to the
    real location because high-accuracy readings dominate."""
    start = UTC(2026, 4, 29, 18, 0)

    # 60 min at Sargent. Most readings are high-accuracy near the
    # centroid; some are low-accuracy and offset 30-40m. The weighted
    # centroid should still be within ~10m of true Sargent.
    pattern: list[tuple[tuple[float, float], float, float]] = []
    pattern.append((SARGENT, 8.0, 0.0))  # tight reading
    for i in range(60):
        if i % 5 == 0:
            # low-accuracy "drift" reading 30-40m off
            offset = 30.0 + (i % 3) * 5.0
            direction_e = (i % 4) - 1.5
            direction_n = ((i // 2) % 4) - 1.5
            coord = offset_meters(
                SARGENT,
                north_m=direction_n * offset / 2,
                east_m=direction_e * offset / 2,
            )
            pattern.append((coord, 28.0, 60.0))  # just within filter
        else:
            # tight reading near anchor
            coord = offset_meters(
                SARGENT,
                north_m=(i % 3) * 2.0,
                east_m=((i + 1) % 3) * 2.0,
            )
            pattern.append((coord, 7.0, 60.0))

    readings = stream(start=start, samples=pattern)
    stays = extract_stay_points(readings)

    assert len(stays) == 1, f"expected 1 stay, got {len(stays)}"
    stay = stays[0]
    centroid_offset = haversine_m(
        stay.centroid_lat, stay.centroid_lng, SARGENT[0], SARGENT[1]
    )
    # Tight readings (acc 7) dominate the weighted centroid 5x over
    # drifty ones (acc 28), so the centroid pulls hard toward Sargent.
    assert centroid_offset < 10, f"centroid drifted {centroid_offset:.1f}m from Sargent"


def test_short_dwell_below_threshold_emits_no_stay() -> None:
    """A 5-minute dwell at default time_threshold_min=8 produces no
    stay — sanity check on the qualification."""
    start = UTC(2026, 4, 29, 12, 0)
    readings = constant_dwell(NORRIS, start=start, duration_minutes=5)
    stays = extract_stay_points(readings)
    assert stays == []


def test_thin_evidence_bridged_gap_rejected() -> None:
    """Two clean readings 4 hours apart at the same coords would
    otherwise produce a confident 4-hour stay from 2 GPS points
    (gap-bridging swallows the silent middle). The min_points guard
    rejects runs with insufficient evidence regardless of dwell."""
    start = UTC(2026, 4, 29, 10, 0)
    readings = stream(
        start=start,
        samples=[
            (NORRIS, 8.0, 0.0),                  # arrive
            (NORRIS, 8.0, 4 * 3600.0),           # 4h later, same place
        ],
    )
    stays = extract_stay_points(readings)
    assert stays == [], "2-point 4-hour bridge should fail min_points"


def test_three_point_bridged_gap_accepted() -> None:
    """A bridged gap WITH at least one reading inside the gap is
    enough evidence — should produce one stay."""
    start = UTC(2026, 4, 29, 10, 0)
    readings = stream(
        start=start,
        samples=[
            (NORRIS, 8.0, 0.0),                  # arrive
            (NORRIS, 12.0, 30 * 60.0),           # 30 min in
            (NORRIS, 8.0, 3.5 * 3600.0),         # 3.5h later, same place
        ],
    )
    stays = extract_stay_points(readings)
    assert len(stays) == 1


def test_two_separated_stays_emit_two() -> None:
    """A stay at Norris, then walking far away, then a stay at Sargent
    must produce two stays. Sanity check on run termination."""
    start = UTC(2026, 4, 29, 10, 0)
    norris_run = constant_dwell(NORRIS, start=start, duration_minutes=15)
    # Transit step — readings between the two anchors, far apart from
    # both. accuracy_m below the filter so they're seen.
    transit_coords = [
        offset_meters(NORRIS, north_m=200.0),
        offset_meters(NORRIS, north_m=350.0),
        offset_meters(SARGENT, north_m=-100.0),
    ]
    transit = stream(
        start=norris_run[-1].ts,
        samples=[(c, 10.0, 60.0) for c in transit_coords],
    )
    sargent_run = constant_dwell(
        SARGENT, start=transit[-1].ts, duration_minutes=15
    )
    readings = norris_run + transit + sargent_run

    stays = extract_stay_points(readings)
    assert len(stays) == 2, f"expected 2 stays, got {len(stays)}"
