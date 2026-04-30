"""`place_visit/v1` deriver.

Pipeline:

    phone.location.reading events in [start, end)
      → SPD (extract_stay_points)
      → brief-exit merge (consecutive same-place stays within grace)
      → for each merged stay:
          → OSM nearest-feature match (centroid → Mapbox Tilequery)
          → upsert places row, get place_id
          → emit DerivedRow(source='place_visit/v1', ...)

Each visit row has deterministic id `uuid5(NAMESPACE_URL,
"place_visit/v1:{start_ts_iso}:{lat:.5f},{lng:.5f}")` so re-running the
same window produces identical rows. `travel_leg/v1` rows reference
visit ids; deterministic ids mean leg references survive replays
without dangling.

`data` carries the user-facing payload (`place_id`, `lat`, `lng`,
`brief_exit_count`); `provenance` carries audit metadata
(`p95_accuracy_m`, `match_confidence`, `stay_dwell_s`,
`source_event_ids`).

OSM lookup failure (timeout / 429 / no feature in radius) does NOT
abort the run — the visit emits with `place_id = NULL` and the
deriver's metrics record an `osm_errors` increment. Mapbox down
shouldn't break a backfill.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import NAMESPACE_URL, UUID, uuid5

from . import register
from ..osm import OSMFeature, lookup_nearest_feature
from ..places_repo import upsert_place
from .base import DerivedRow, DeterministicDeriver, IdempotencyMode
from .stay_points import GPSReading, extract_stay_points, merge_brief_exits

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.derivers.place_visit")

SOURCE = "place_visit/v1"


class PlaceVisitV1Deriver(DeterministicDeriver):
    """Detects place visits from raw GPS using SPD + OSM matching.

    Knobs are class attributes so subclasses (or alternate-tuned
    instances) can override without rebuilding the pipeline. Real-data
    threshold tuning happens after backfill (see plan-place-visit-v1.md
    "Open knobs").
    """

    SOURCE = SOURCE
    INPUTS = ("phone.location.reading",)
    # Span deriver — overnight stays cross window boundaries.
    IDEMPOTENCY_MODE = IdempotencyMode.OVERLAP_REPLACE

    # SPD parameters
    accuracy_max_m: float = 30.0
    dist_threshold_m: float = 40.0
    # Lowered from 8.0 → 4.0 on 2026-04-30 after the user's morning
    # walk surfaced two real stops the deriver had been suppressing:
    #   11:13-11:17 (4 min) at Tech building — clustered 5 readings
    #   within ~25m, clearly a destination not a crosswalk pause
    #   11:22-11:24+ (2 min and ongoing) at the garage
    # 8 min was tuned for "long sit-down visits" but missed these.
    # 4 min still rejects 30s-2min walking pauses (crosswalks, brief
    # window-stops). Companion `min_points: 3` keeps thin-evidence
    # clusters out — 3 readings min still required.
    time_threshold_min: float = 4.0
    gap_threshold_hours: float = 4.0
    min_points: int = 3

    # Brief-exit merge parameters
    brief_exit_max_gap_min: float = 10.0

    # OSM matching parameters. Mapbox places building-name POIs at
    # the building's centroid (not its entrance), so the distance
    # from a stay-centroid (typically near a door) to the POI is
    # bounded by building geometry, not GPS quality. 50m comfortably
    # accommodates that for typical campus buildings; the planned ⚠
    # confidence indicator surfaces the low-trust band rather than a
    # hard cutoff dropping legitimate matches. Tried 35m, lost
    # Kellogg Global Hub (POI was 36.5m from centroid) — reverted.
    osm_match_radius_m: int = 50

    # `same_place_max_gap_hours` knob removed 2026-04-30. The
    # `_merge_same_place_long_gaps` pass it controlled inferred
    # "user stayed at the same place across this gap" PURELY from the
    # bracketing visits' place_id, with no access to the GPS readings
    # in the gap. It collapsed real walks (e.g. the morning 03:30-03:55
    # walk, where the user left Willard, walked ~880m, and returned).
    #
    # The right answer is to NOT add an inference layer that can't see
    # the underlying evidence. SPD's stay-point detection already sees
    # all readings chronologically and emits separate stays when motion
    # interrupts. Two outdoor windows at home with a long no-GPS gap
    # between them now render as two visits + a `tracking_gap` row in
    # the dashboard — a faithful "we observed two windows of activity"
    # rather than a fabricated "you stayed at home for 14 hours."

    # `is_open` ("currently here") is computed at READ time in
    # v_place_visit_today against NOW() — see migration 0010. Keeping
    # it write-time (via a per-tick knob) was fragile: an agent crash
    # would leave is_open=true on yesterday's row indefinitely, and
    # the value could only be refreshed on the rare ticks that
    # re-emitted that row.

    def compute(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> tuple[list[DerivedRow], dict[str, Any]]:
        # Lookback so SPD sees readings that started a stay BEFORE the
        # window. Without this, a visit that began earlier and extends
        # into the window would get its early-readings hidden, and SPD
        # would emit a phantom new visit anchored at the first
        # in-window reading — duplicating an existing pre-window row.
        # 2x gap_threshold is enough headroom to capture any visit
        # that could plausibly extend into the window.
        lookback_hours = self.gap_threshold_hours * 2
        fetch_start = start - timedelta(hours=lookback_hours)
        readings = self._fetch_readings(conn, fetch_start, end)
        readings_total = len(readings)

        stays = extract_stay_points(
            readings,
            accuracy_max_m=self.accuracy_max_m,
            dist_threshold_m=self.dist_threshold_m,
            time_threshold_min=self.time_threshold_min,
            gap_threshold_hours=self.gap_threshold_hours,
            min_points=self.min_points,
        )
        merged = merge_brief_exits(
            stays,
            max_gap_min=self.brief_exit_max_gap_min,
            dist_threshold_m=self.dist_threshold_m,
        )

        rows: list[DerivedRow] = []
        metrics: dict[str, Any] = {
            "readings_total": readings_total,
            "stays_detected": len(stays),
            "stays_after_merge": len(merged),
            "stays_pre_window_skipped": 0,
            "null_place_visits": 0,
            "osm_errors": 0,
            "match_confidences": [],
        }

        for stay, brief_count in merged:
            # Stays whose end_ts is at or before window_start are entirely
            # in lookback territory; they don't overlap our window so
            # OVERLAP_REPLACE wouldn't accept them and we shouldn't emit.
            if stay.end_ts <= start:
                metrics["stays_pre_window_skipped"] += 1
                continue
            place_id = None
            match_confidence = 0.0
            feature: OSMFeature | None = None
            try:
                feature = lookup_nearest_feature(
                    stay.centroid_lat,
                    stay.centroid_lng,
                    radius_m=self.osm_match_radius_m,
                )
            except Exception as exc:  # noqa: BLE001 — OSM is best-effort
                log.warning(
                    "OSM lookup raised at (%.5f, %.5f): %s",
                    stay.centroid_lat,
                    stay.centroid_lng,
                    exc,
                )
                metrics["osm_errors"] += 1

            if feature is not None:
                try:
                    place_id = upsert_place(conn, feature)
                    # Linear ramp from 1.0 (centroid on the feature) to
                    # 0.0 (at the radius boundary). Coarse but
                    # interpretable.
                    match_confidence = max(
                        0.0,
                        1.0 - (feature.distance_m / float(self.osm_match_radius_m)),
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "upsert_place failed for %s:%s — %s",
                        feature.feature_type,
                        feature.feature_id,
                        exc,
                    )
                    place_id = None
                    metrics["osm_errors"] += 1

            if place_id is None:
                metrics["null_place_visits"] += 1

            metrics["match_confidences"].append(round(match_confidence, 3))

            row_id = _deterministic_visit_id(
                stay.start_ts,
                stay.centroid_lat,
                stay.centroid_lng,
            )

            data: dict[str, Any] = {
                # `place_id` matches the dashboard's PlaceVisit.data
                # contract. NULL when no OSM feature matched.
                "place_id": str(place_id) if place_id is not None else None,
                "lat": stay.centroid_lat,
                "lng": stay.centroid_lng,
                "brief_exit_count": brief_count,
            }

            provenance: dict[str, Any] = {
                "inputs": list(self.INPUTS),
                "source_event_ids": [str(eid) for eid in stay.event_ids],
                "p95_accuracy_m": stay.p95_accuracy_m,
                "match_confidence": match_confidence,
                "stay_dwell_s": stay.dwell_s,
                "stay_point_count": stay.point_count,
            }

            rows.append(
                DerivedRow(
                    id=row_id,
                    source=self.SOURCE,
                    start_ts=stay.start_ts,
                    end_ts=stay.end_ts,
                    data=data,
                    provenance=provenance,
                )
            )

        return rows, metrics

    def _fetch_readings(
        self,
        conn: "psycopg.Connection",
        start: datetime,
        end: datetime,
    ) -> list[GPSReading]:
        """Pull `phone.location.reading` events in the window into
        `GPSReading` records, ordered by timestamp."""
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, start_ts,
                       (data->>'lat')::float8,
                       (data->>'lng')::float8,
                       COALESCE((data->>'accuracy_m')::float8, 9999.0)
                  FROM public.events
                 WHERE source = 'phone.location.reading'
                   AND start_ts >= %s
                   AND start_ts <  %s
                 ORDER BY start_ts
                """,
                (start, end),
            )
            return [
                GPSReading(
                    id=row[0],
                    ts=row[1],
                    lat=float(row[2]),
                    lng=float(row[3]),
                    accuracy_m=float(row[4]),
                )
                for row in cur.fetchall()
            ]


def _deterministic_visit_id(
    start_ts: datetime,
    lat: float,
    lng: float,
) -> UUID:
    """Stable id for a place_visit row.

    Re-deriving the same window produces the same id — `travel_leg/v1`
    rows that reference visit ids by `from_visit_id`/`to_visit_id`
    stay valid across replays.

    Coords rounded to 5 decimals (~1m). Timestamp serialized to
    second-precision so sub-second jitter doesn't flip the id.
    """
    key = (
        f"place_visit/v1:"
        f"{start_ts.replace(microsecond=0).isoformat()}:"
        f"{lat:.5f},{lng:.5f}"
    )
    return uuid5(NAMESPACE_URL, key)


# Auto-register the default-tuned instance at module load. The CLI
# (tools.run_deriver) and the agent's scheduler both rely on
# `import scrollantir.core.derivers.place_visit` populating the
# REGISTRY. Alternate-tuned instances can be registered manually with
# a different SOURCE; collisions raise on import.
register(PlaceVisitV1Deriver())
