"""Per-window deriver runner — ad-hoc invocation for tuning + debugging.

Usage:

    # List registered derivers
    python -m scrollantir.tools.run_deriver list

    # Run a specific deriver over an explicit window
    python -m scrollantir.tools.run_deriver run \\
        --source place_visit/v1 \\
        --start 2026-04-29T04:00:00Z \\
        --end   2026-04-30T04:00:00Z

The CLI is the actual debug tool — pre-scheduler, this is how Josh
re-derives a single day after tweaking thresholds, inspects the
metrics, and decides whether the output looks right before adjusting
in place_visit.py.

Connects via `core.db.connect_agent` (DATABASE_URL or PG* envs); see
that module for env-var conventions.
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime

# Importing concrete deriver modules side-effect-registers them in the
# REGISTRY. Add new derivers here as they ship.
import scrollantir.core.derivers.place_visit  # noqa: F401

from scrollantir.core.db import close_after, connect_agent
from scrollantir.core.derivers import REGISTRY


def _parse_iso(s: str) -> datetime:
    """Parse an ISO 8601 timestamp. Accepts trailing `Z` shorthand."""
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _cmd_list() -> int:
    if not REGISTRY:
        print("(no derivers registered)")
        return 0
    width = max(len(s) for s in REGISTRY)
    for source, deriver in sorted(REGISTRY.items()):
        print(f"{source:<{width}}  {type(deriver).__name__}")
    return 0


def _cmd_run(source: str, start: datetime, end: datetime) -> int:
    deriver = REGISTRY.get(source)
    if deriver is None:
        print(f"unknown deriver: {source}", file=sys.stderr)
        print(f"registered: {sorted(REGISTRY)}", file=sys.stderr)
        return 2

    if end <= start:
        print("--end must be > --start", file=sys.stderr)
        return 2

    with close_after(connect_agent()) as conn:
        result = deriver.run(conn, start, end)

    print(f"deriver:       {source}")
    print(f"window:        [{start.isoformat()}, {end.isoformat()})")
    print(f"rows_written:  {result.rows_written}")
    if result.metrics:
        print("metrics:")
        for k, v in result.metrics.items():
            print(f"  {k}: {v}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="run-deriver")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="list registered derivers")

    p_run = sub.add_parser("run", help="run a deriver over a window")
    p_run.add_argument(
        "--source",
        required=True,
        help="deriver source (e.g. place_visit/v1)",
    )
    p_run.add_argument(
        "--start",
        required=True,
        type=_parse_iso,
        help="window start (ISO 8601, e.g. 2026-04-29T04:00:00Z)",
    )
    p_run.add_argument(
        "--end",
        required=True,
        type=_parse_iso,
        help="window end (ISO 8601, exclusive)",
    )

    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
        stream=sys.stdout,
    )

    if args.cmd == "list":
        return _cmd_list()
    if args.cmd == "run":
        return _cmd_run(args.source, args.start, args.end)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
