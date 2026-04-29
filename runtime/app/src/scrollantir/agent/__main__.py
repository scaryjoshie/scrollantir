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
import scrollantir.core.derivers.travel_leg  # noqa: F401

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
# How far back from now() each tick re-derives. Generous so late-
# arriving GPS or activity-state events from earlier in the day still
# get folded in. Single-user data volume makes this cheap.
ROLLING_WINDOW_HOURS = 24

# Order matters: travel_leg reads place_visit rows from derived_events.
DERIVER_CHAIN: tuple[str, ...] = (
    "place_visit/v1",
    "travel_leg/v1",
)


def run_recent_derivers() -> None:
    """Re-derive the deriver chain over the rolling last-N-hours
    window. Each call is idempotent via replace_derived_window.
    Errors are logged and swallowed so one bad tick doesn't kill
    the scheduler."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=ROLLING_WINDOW_HOURS)
    log.info(
        "derivers tick: window=[%s, %s)",
        start.isoformat(),
        end.isoformat(),
    )
    try:
        with close_after(connect_agent()) as conn:
            for source in DERIVER_CHAIN:
                deriver = REGISTRY.get(source)
                if deriver is None:
                    log.error("missing deriver %s in REGISTRY", source)
                    continue
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
        "scheduler starting — derivers run every %d min over rolling %dh",
        DERIVER_INTERVAL_MINUTES,
        ROLLING_WINDOW_HOURS,
    )
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        log.info("scheduler stopping")


if __name__ == "__main__":
    main()
