"""Shared test fixtures + helpers.

Most tests in this package are deriver-algorithm tests over synthetic
GPS streams. The helpers below produce realistic-looking
`GPSReading` sequences without needing a database.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Iterable
from uuid import uuid4

from scrollantir.core.derivers.stay_points import GPSReading

# Northwestern Evanston landmark coords (lat, lng), reused as test
# anchors. The dashboard fixture uses these too.
SARGENT = (42.0571, -87.6747)   # residence
TECH = (42.0581, -87.6753)      # CS / Tech Institute
NORRIS = (42.0531, -87.6745)    # student union
MUDD = (42.0588, -87.6743)      # science library


def offset_meters(
    base: tuple[float, float],
    north_m: float = 0.0,
    east_m: float = 0.0,
) -> tuple[float, float]:
    """Return (lat, lng) shifted by (north, east) meters from `base`.

    Flat-earth approximation — fine for the < 1 km scales these tests
    cover. Latitude: 1 deg ≈ 111_320 m. Longitude: scales by cos(lat).
    """
    lat, lng = base
    dlat = north_m / 111_320.0
    dlng = east_m / (111_320.0 * math.cos(math.radians(lat)))
    return (lat + dlat, lng + dlng)


def stream(
    *,
    start: datetime,
    samples: Iterable[tuple[tuple[float, float], float, float]],
) -> list[GPSReading]:
    """Build a `[GPSReading, ...]` from a compact spec.

    Each `samples` entry is `(coord, accuracy_m, dt_seconds)` —
    `coord` is `(lat, lng)`, `dt_seconds` is the gap from the previous
    reading. The first entry's `dt_seconds` is ignored (anchors at
    `start`). Returns a chronologically-sorted list.
    """
    out: list[GPSReading] = []
    ts = start
    for i, (coord, acc, dt) in enumerate(samples):
        if i > 0:
            ts = ts + timedelta(seconds=dt)
        out.append(
            GPSReading(
                id=uuid4(),
                ts=ts,
                lat=coord[0],
                lng=coord[1],
                accuracy_m=acc,
            )
        )
    return out


def constant_dwell(
    base: tuple[float, float],
    *,
    start: datetime,
    duration_minutes: float,
    sample_period_s: float = 30.0,
    accuracy_m: float = 12.0,
    jitter_m: float = 8.0,
) -> list[GPSReading]:
    """Build a sequence of readings dwelling near `base` for
    `duration_minutes`, sampled every `sample_period_s`.

    Each reading is jittered by up to `jitter_m` meters in a deterministic
    pattern (golden-angle rotation) — same input → same readings, so
    tests reproduce.
    """
    out: list[GPSReading] = []
    n = int((duration_minutes * 60.0) / sample_period_s) + 1
    for i in range(n):
        angle = (i * 137.5) % 360.0
        rad = math.radians(angle)
        dx = jitter_m * math.cos(rad) * (i % 3) / 3.0
        dy = jitter_m * math.sin(rad) * (i % 3) / 3.0
        coord = offset_meters(base, north_m=dy, east_m=dx)
        ts = start + timedelta(seconds=i * sample_period_s)
        out.append(
            GPSReading(
                id=uuid4(),
                ts=ts,
                lat=coord[0],
                lng=coord[1],
                accuracy_m=accuracy_m,
            )
        )
    return out


def UTC(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
