"""scrollantir agent — in-process scheduler.

APScheduler will own cron-fired forward() passes and the 60s complete()
poll once derivers ship. For commit #1 this is a tick stub that proves
the scheduler is alive in the container.
"""

import logging
import sys

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.interval import IntervalTrigger

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S%z",
    stream=sys.stdout,
)
log = logging.getLogger("scrollantir.agent")


def tick() -> None:
    log.info("tick")


def main() -> None:
    sched = BlockingScheduler(timezone="UTC")
    sched.add_job(
        tick,
        IntervalTrigger(seconds=60),
        id="tick",
        coalesce=True,
        max_instances=1,
    )
    log.info("scheduler starting (tick every 60s)")
    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        log.info("scheduler stopping")


if __name__ == "__main__":
    main()
