"""Service-role connection to Supabase Postgres.

Resolution order for the DSN:
  1. $SCROLLANTIR_ADMIN_DATABASE_URL
  2. DATABASE_URL= line in scripts/.env.admin

The DSN is never logged. Error messages say only that it's missing.
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


def parse_dsn(dsn: str) -> DsnParts:
    parsed = urllib.parse.urlparse(dsn)
    if not parsed.hostname:
        raise SystemExit("Admin DATABASE_URL is malformed: missing host.")
    database = (parsed.path or "/postgres").lstrip("/") or "postgres"
    return DsnParts(
        host=parsed.hostname,
        port=parsed.port or 5432,
        database=database,
    )


def project_ref(host: str) -> str:
    """Extract <ref> from a direct-connection host 'db.<ref>.supabase.co'.

    Fails loudly on anything else — in particular on pooler hosts
    (aws-0-*.pooler.supabase.com), since their username format
    (postgres.<ref>) would break role substitution in setup-roles.
    """
    parts = host.split(".")
    if len(parts) == 4 and parts[0] == "db" and parts[-2:] == ["supabase", "co"]:
        return parts[1]
    raise SystemExit(
        f"Could not extract project ref from DB host. Expected "
        f"'db.<project-ref>.supabase.co' (the direct connection); "
        f"the session pooler URL is not supported."
    )


def build_role_dsn(role: str, password: str, parts: DsnParts) -> str:
    """Build a fresh DSN for a custom role. URL-encode the password even
    though token_urlsafe only emits URL-safe chars — defensive hygiene."""
    encoded = urllib.parse.quote(password, safe="")
    return (
        f"postgresql://{role}:{encoded}"
        f"@{parts.host}:{parts.port}/{parts.database}"
    )


def connect() -> psycopg.Connection:
    return psycopg.connect(get_dsn())
