"""DB connection helpers for the agent + CLI.

Single entry point: `connect_agent()` returns a psycopg connection
authenticated as `agent_role`. Used by deriver runs (the
`DeterministicDeriver.run` flow needs a `psycopg.Connection`) and by
the per-window CLI in `bin/run_deriver.py`.

Env var precedence:
    1. `DATABASE_URL` if set — the canonical "everything in one string"
       form (postgresql://agent:pw@host:5432/scrollantir)
    2. otherwise, PG* envs (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`,
       `PGPORT`) which psycopg picks up from the environment
       automatically when no DSN is provided

The agent compose service needs `DATABASE_URL` (or the PG* set)
plumbed through its `environment:` block — the ingest API uses a
different role, so just reusing `POSTGRES_PASSWORD` won't authorize
the agent. See `runtime/db/schemas/20_roles.sh` for how `AGENT_PW` is
wired during Postgres init.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import TYPE_CHECKING, Iterator

if TYPE_CHECKING:
    import psycopg

log = logging.getLogger("scrollantir.db")


def connect_agent() -> "psycopg.Connection":
    """Open a fresh psycopg connection authenticated as `agent_role`.

    Returns a connection in the default (autocommit=False) mode —
    derivers manage their own transaction boundaries via
    `replace_derived_window`-then-commit. Caller owns the lifecycle
    (use `close_after()` or a `with` block).
    """
    import psycopg  # lazy

    dsn = os.environ.get("DATABASE_URL", "").strip()
    if dsn:
        log.debug("connecting via DATABASE_URL")
        return psycopg.connect(dsn)
    # Falls through to libpq env discovery (PGHOST, PGUSER, PGPASSWORD,
    # PGDATABASE, PGPORT). Useful for local `psql`-style ergonomics.
    log.debug("connecting via PG* env vars")
    return psycopg.connect()


@contextmanager
def close_after(conn: "psycopg.Connection") -> Iterator["psycopg.Connection"]:
    """Context manager that closes a connection on exit (committed or
    rolled back as the caller already managed). Useful in CLI mains."""
    try:
        yield conn
    finally:
        conn.close()
