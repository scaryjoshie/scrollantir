"""Service-role connection to Supabase Postgres.

Resolution order for the DSN:
  1. $SCROLLANTIR_ADMIN_DATABASE_URL
  2. DATABASE_URL= line in scripts/.env.admin

The DSN is never logged. Error messages say only that it's missing.

Supported DSN flavors:
  - Direct:         postgresql://postgres:PWD@db.<ref>.supabase.co:5432/postgres
                    (requires IPv6 outbound; Supabase stopped serving IPv4
                     on the direct host without a paid add-on)
  - Session Pooler: postgresql://postgres.<ref>:PWD@aws-0-<region>.pooler.supabase.com:5432/postgres
                    (IPv4-accessible; the default now)

Both shapes work; the admin CLI auto-detects which one was pasted and
builds per-role DSNs in the same shape.
"""

from __future__ import annotations

import os
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

import psycopg

ENV_VAR = "SCROLLANTIR_ADMIN_DATABASE_URL"
ENV_FILE = Path(__file__).resolve().parent.parent / ".env.admin"


def _load_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        out[key.strip()] = value
    return out


def get_dsn() -> str:
    dsn = os.environ.get(ENV_VAR)
    if dsn:
        return dsn
    dsn = _load_env_file(ENV_FILE).get("DATABASE_URL")
    if dsn:
        return dsn
    raise SystemExit(
        f"No admin DATABASE_URL. Set ${ENV_VAR} or put "
        f"DATABASE_URL=... in scripts/.env.admin."
    )


@dataclass(frozen=True)
class DsnParts:
    host: str
    port: int
    database: str
    username: str         # "postgres" (direct) or "postgres.<ref>" (pooler)
    project_ref: str      # extracted regardless of shape
    is_pooler: bool


def parse_dsn(dsn: str) -> DsnParts:
    parsed = urllib.parse.urlparse(dsn)
    host = parsed.hostname
    username = parsed.username or ""

    if not host:
        raise SystemExit("Admin DATABASE_URL is malformed: missing host.")
    if not username:
        raise SystemExit("Admin DATABASE_URL is malformed: missing username.")

    database = (parsed.path or "/postgres").lstrip("/") or "postgres"
    port = parsed.port or 5432

    # Pooler: host like aws-0-us-east-1.pooler.supabase.com,
    # username like postgres.<projectref>.
    if host.endswith(".pooler.supabase.com"):
        if "." not in username:
            raise SystemExit(
                "Pooler DSN username must be '<role>.<project-ref>' "
                f"(e.g. 'postgres.feijpewzqgqczkxmvdng'); got '{username}'. "
                "Copy the exact URL from Supabase dashboard → Database → "
                "Connection string → Session pooler."
            )
        base_role, _, project_ref = username.partition(".")
        if not project_ref:
            raise SystemExit("Pooler DSN username has empty project ref.")
        if base_role != "postgres":
            raise SystemExit(
                f"Admin DSN must authenticate as 'postgres.<ref>' (service-role "
                f"equivalent); got base role '{base_role}'."
            )
        return DsnParts(
            host=host,
            port=port,
            database=database,
            username=username,
            project_ref=project_ref,
            is_pooler=True,
        )

    # Direct: host like db.<ref>.supabase.co, username is 'postgres'.
    parts = host.split(".")
    if len(parts) == 4 and parts[0] == "db" and parts[-2:] == ["supabase", "co"]:
        if username != "postgres":
            raise SystemExit(
                f"Admin DSN must authenticate as 'postgres' on a direct "
                f"connection (service-role equivalent); got '{username}'. "
                f"If you meant to use a pre-scoped role, run the admin CLI "
                f"from the `postgres` account instead."
            )
        return DsnParts(
            host=host,
            port=port,
            database=database,
            username=username,
            project_ref=parts[1],
            is_pooler=False,
        )

    raise SystemExit(
        f"Unrecognized Postgres host '{host}'. Expected either "
        f"'db.<ref>.supabase.co' (direct) or "
        f"'aws-0-<region>.pooler.supabase.com' (session pooler)."
    )


def build_role_dsn(role: str, password: str, parts: DsnParts) -> str:
    """Build a DSN for a custom role in the same shape as the admin DSN.

    Pooler DSNs require the username to be '<role>.<project-ref>' so
    Supavisor can route to the right project. Direct DSNs use the bare
    role name. `secrets.token_urlsafe` emits URL-safe chars only; the
    `quote(safe='')` is defensive.
    """
    encoded = urllib.parse.quote(password, safe="")
    username = f"{role}.{parts.project_ref}" if parts.is_pooler else role
    return (
        f"postgresql://{username}:{encoded}"
        f"@{parts.host}:{parts.port}/{parts.database}"
    )


def connect() -> psycopg.Connection:
    return psycopg.connect(get_dsn())
