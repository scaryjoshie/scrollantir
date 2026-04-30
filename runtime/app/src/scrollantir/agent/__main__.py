"""scrollantir agent — in-process scheduler.

APScheduler ticks the deriver chain every DERIVER_INTERVAL_MINUTES
over a rolling-24h window. Each tick uses
`agent_api.replace_derived_window` so it's idempotent — the sliding
window strictly overwrites its own range, leaving older rows
untouched. Adding new derivers later: import the module here, the
registry picks them up automatically.

The first tick fires ~10s after container start so a fresh boot
catches up immediately rather than waiting a full interval.
"""

from __future__ import annotations

import logging
import sys
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.interval import IntervalTrigger

# Importing the deriver modules side-effect-registers them in
# core.derivers.REGISTRY. Add new derivers here as they ship.
import scrollantir.core.derivers.place_visit  # noqa: F401
import scrollantir.core.derivers.sleep  # noqa: F401
import scrollantir.core.derivers.travel_leg  # noqa: F401
import scrollantir.core.derivers.user_active  # noqa: F401

from scrollantir.core.db import close_after, connect_agent
from scrollantir.core.derivers import REGISTRY

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S%z",
    stream=sys.stdout,
)
log = logging.getLogger("scrollantir.agent")


# How often the rolling-window deriver tick fires.
DERIVER_INTERVAL_MINUTES = 5

# Per-source rolling-window length. Sleep + user_active both need 36h
# so they cover last night plus tonight even when the tick fires late
# in the day. They also need to MATCH each other so sleep doesn't
# read a stale tail of user_active rows. Place_visit / travel_leg do
# fine on 24h.
WINDOW_HOURS_BY_SOURCE: dict[str, int] = {
    "place_visit/v1": 24,
    "travel_leg/v1": 24,
    "user_active/v1": 36,
    "sleep/v1": 36,
}
DEFAULT_ROLLING_WINDOW_HOURS = 24

# Order matters: travel_leg reads place_visit rows; sleep reads
# user_active rows. Each deriver runs over its own per-source window.
DERIVER_CHAIN: tuple[str, ...] = (
    "place_visit/v1",
    "travel_leg/v1",
    "user_active/v1",
    "sleep/v1",
)


def run_recent_derivers() -> None:
    """Re-derive the deriver chain over per-source rolling windows.
    Each call is idempotent via replace_derived_window. Errors are
    logged and swallowed so one bad tick doesn't kill the scheduler.

    Window length comes from `WINDOW_HOURS_BY_SOURCE`. Sleep +
    user_active match (36h) so sleep doesn't read a stale tail.
    """
    end = datetime.now(timezone.utc)
    try:
        with close_after(connect_agent()) as conn:
            for source in DERIVER_CHAIN:
                deriver = REGISTRY.get(source)
                if deriver is None:
                    log.error("missing deriver %s in REGISTRY", source)
                    continue
                hours = WINDOW_HOURS_BY_SOURCE.get(
                    source, DEFAULT_ROLLING_WINDOW_HOURS
                )
                start = end - timedelta(hours=hours)
                log.info(
                    "derivers tick: source=%s window=[%s, %s)",
                    source,
                    start.isoformat(),
                    end.isoformat(),
                )
                result = deriver.run(conn, start, end)
                log.info(
                    "deriver=%s rows=%d metrics=%s",
                    source,
                    result.rows_written,
                    result.metrics,
                )
    except Exception:
        # Don't take down the scheduler on a transient DB hiccup or
        # Mapbox outage — the next tick reruns the same window.
        log.exception("deriver tick failed; will retry on next interval")


def main() -> None:
    sched = BlockingScheduler(timezone="UTC")
    sched.add_job(
        run_recent_derivers,
        IntervalTrigger(minutes=DERIVER_INTERVAL_MINUTES),
        id="derivers",
        coalesce=True,
        max_instances=1,
        # First fire shortly after start so a fresh boot catches up
        # without waiting a full interval.
        next_run_time=datetime.now(timezone.utc) + timedelta(seconds=10),
    )
    log.info(
        "scheduler starting — derivers run every %d min, windows=%s",
        DERIVER_INTERVAL_MINUTES,
        WINDOW_HOURS_BY_SOURCE,
    )
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        log.info("scheduler stopping")


if __name__ == "__main__":
    main()
