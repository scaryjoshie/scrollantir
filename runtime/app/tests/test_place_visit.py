"""`place_visit/v1` pipeline tests (post-SPD branches).

SPD-level cases (a-c) live in `test_stay_points.py`. These cover the
pipeline-level branches: OSM matching, OSM failure, NULL place
fallback, brief-exit merge, deterministic ids.

Tests g (window boundary) and h (late-arriving GPS replay) need a
real DB to exercise `replace_derived_window` — deferred to a future
integration test pass once we have a Postgres test fixture.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import UUID, uuid4

from scrollantir.core.osm import OSMFeature
from scrollantir.core.derivers.place_visit import (
    PlaceVisitV1Deriver,
    _deterministic_visit_id,
)
from scrollantir.core.derivers.stay_points import GPSReading

from .conftest import (
    NORRIS,
    SARGENT,
    TECH,
    UTC,
    constant_dwell,
    offset_meters,
    stream,
)


class _StubFetcher(PlaceVisitV1Deriver):
    """Test subclass that returns canned readings instead of querying
    `public.events`. Lets us exercise `compute()` without a real DB."""

    def __init__(self, readings: list[GPSReading]):
        self._stub_readings = readings

    def _fetch_readings(self, conn, start, end):  # type: ignore[override]
        return self._stub_readings


def _osm_feature(name: str, category: str, lat: float, lng: float, distance_m: float = 5.0) -> OSMFeature:
    """Make a synthetic OSMFeature for tests."""
    return OSMFeature(
        feature_type="building",
        feature_id=hash(name) & 0x7FFFFFFF,
        name=name,
        category=category,
        centroid_lat=lat,
        centroid_lng=lng,
        distance_m=distance_m,
        raw_properties={"class": category, "name": name},
    )


# ---------------------------------------------------------------------------
# d. First week with zero places — OSM returns None for all centroids
# ---------------------------------------------------------------------------

def test_d_zero_places_emits_null_place_id(monkeypatch) -> None:
    """When OSM has no feature in radius, the visit emits with
    place_id=NULL. The deriver must NOT abort or fabricate a name."""
    readings = constant_dwell(
        NORRIS, start=UTC(2026, 4, 29, 14, 0), duration_minutes=20
    )
    deriver = _StubFetcher(readings)
    monkeypatch.setattr(
        "scrollantir.core.derivers.place_visit.lookup_nearest_feature",
        lambda lat, lng, radius_m=50: None,
    )

    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 14, 0), UTC(2026, 4, 29, 15, 0)
    )

    assert len(rows) == 1
    assert rows[0].data["place_id"] is None
    assert rows[0].data["lat"] != 0
    assert rows[0].data["lng"] != 0
    assert metrics["null_place_visits"] == 1
    assert metrics["stays_detected"] == 1
    # provenance still well-formed
    assert rows[0].provenance["inputs"] == ["phone.location.reading"]
    assert len(rows[0].provenance["source_event_ids"]) > 0


# ---------------------------------------------------------------------------
# e. Two buildings on distinct schedules — separate visits w/ distinct ids
# ---------------------------------------------------------------------------

def test_e_two_buildings_distinct_visits(monkeypatch) -> None:
    """Sequential visits to two different places get separate rows
    with separate place_ids. The OSM stub routes by latitude band."""
    norris_uuid = uuid4()
    tech_uuid = uuid4()

    def fake_lookup(lat: float, lng: float, radius_m: int = 50) -> OSMFeature | None:
        if abs(lat - NORRIS[0]) < 0.0005:
            return _osm_feature("Norris", "food", *NORRIS)
        if abs(lat - TECH[0]) < 0.0005:
            return _osm_feature("Tech", "class", *TECH)
        return None

    def fake_upsert(conn, feature: OSMFeature) -> UUID:
        return norris_uuid if feature.name == "Norris" else tech_uuid

    monkeypatch.setattr(
        "scrollantir.core.derivers.place_visit.lookup_nearest_feature",
        fake_lookup,
    )
    monkeypatch.setattr(
        "scrollantir.core.derivers.place_visit.upsert_place",
        fake_upsert,
    )

    start = UTC(2026, 4, 29, 10, 0)
    norris_run = constant_dwell(NORRIS, start=start, duration_minutes=15)
    transit = stream(
        start=norris_run[-1].ts,
        samples=[
            (offset_meters(NORRIS, north_m=200.0), 10.0, 60.0),
            (offset_meters(NORRIS, north_m=400.0), 10.0, 60.0),
            (offset_meters(TECH, north_m=-100.0), 10.0, 60.0),
        ],
    )
    tech_run = constant_dwell(TECH, start=transit[-1].ts, duration_minutes=15)
    deriver = _StubFetcher(norris_run + transit + tech_run)

    rows, metrics = deriver.compute(None, start, start + timedelta(hours=2))

    assert len(rows) == 2
    place_ids = {r.data["place_id"] for r in rows}
    assert place_ids == {str(norris_uuid), str(tech_uuid)}
    assert metrics["null_place_visits"] == 0
    # IDs are deterministic — two different start_ts AND centroids
    # produce different visit ids.
    assert rows[0].id != rows[1].id


# ---------------------------------------------------------------------------
# i. OSM lookup raises — visit still emits with place_id=NULL
# ---------------------------------------------------------------------------

def test_i_osm_exception_does_not_abort(monkeypatch) -> None:
    """A network failure / timeout from Mapbox must not break the
    backfill. Visit emits with place_id=NULL and metrics record the
    OSM error."""

    def explode(lat: float, lng: float, radius_m: int = 50) -> OSMFeature | None:
        raise RuntimeError("simulated Mapbox 503")

    monkeypatch.setattr(
        "scrollantir.core.derivers.place_visit.lookup_nearest_feature",
        explode,
    )

    readings = constant_dwell(
        SARGENT, start=UTC(2026, 4, 29, 22, 0), duration_minutes=30
    )
    deriver = _StubFetcher(readings)

    rows, metrics = deriver.compute(
        None, UTC(2026, 4, 29, 22, 0), UTC(2026, 4, 29, 23, 0)
    )

    assert len(rows) == 1
    assert rows[0].data["place_id"] is None
    assert metrics["osm_errors"] == 1
    assert metrics["null_place_visits"] == 1


# ---------------------------------------------------------------------------
# Brief-exit merge — bathroom break case
# ---------------------------------------------------------------------------

def test_brief_exit_merges_two_stays_into_one(monkeypatch) -> None:
    """A 5-minute walk-out-and-back at Norris should produce ONE visit
    with brief_exit_count=1, not two visits."""
    monkeypatch.setattr(
        "scrollantir.core.derivers.place_visit.lookup_nearest_feature",
        lambda lat, lng, radius_m=50: _osm_feature("Norris", "food", *NORRIS),
    )
    monkeypatch.setattr(
        "scrollantir.core.derivers.place_visit.upsert_place",
        lambda conn, f: uuid4(),
    )

    start = UTC(2026, 4, 29, 13, 0)
    # 30 min at Norris, 5 min away (a coffee run), 25 min back at Norris.
    pre = constant_dwell(NORRIS, start=start, duration_minutes=30)
    away_coord = offset_meters(NORRIS, east_m=300.0)
    away = stream(
        start=pre[-1].ts,
        samples=[(away_coord, 10.0, 60.0)] * 5,
    )
    post = constant_dwell(
        NORRIS, start=away[-1].ts, duration_minutes=25
    )
    deriver = _StubFetcher(pre + away + post)

    rows, metrics = deriver.compute(None, start, start + timedelta(hours=2))

    assert len(rows) == 1, f"expected 1 merged visit, got {len(rows)}"
    assert rows[0].data["brief_exit_count"] == 1
    assert metrics["stays_detected"] == 2  # SPD saw two
    assert metrics["stays_after_merge"] == 1  # merge collapsed them


# ---------------------------------------------------------------------------
# Deterministic id stability
# ---------------------------------------------------------------------------

# `is_open` — moved to read-time computation in v_place_visit_today
# (migration 0010); no longer write-time deriver state. The deriver
# emits no `is_open` field; the view computes against NOW().


def test_deterministic_visit_id_stable() -> None:
    """The visit id is a uuid5 of (timestamp_seconds, lat:.5f, lng:.5f).
    Reruns with sub-microsecond / sub-1m drift produce the same id."""
    ts1 = UTC(2026, 4, 29, 10, 0)
    ts2 = ts1.replace(microsecond=999_999)  # sub-second drift
    id1 = _deterministic_visit_id(ts1, 42.05710, -87.67470)
    id2 = _deterministic_visit_id(ts2, 42.057101, -87.674702)
    assert id1 == id2

    # Different timestamp at the same coords → different id.
    id3 = _deterministic_visit_id(
        ts1 + timedelta(seconds=1), 42.05710, -87.67470
    )
    assert id1 != id3
