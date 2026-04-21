"""setup-roles: assign random passwords to ingest_role / user_role /
agent_role and write per-role connection strings to the macOS Keychain.

The roles are created NOLOGIN in supabase/roles.sql. ALTER ROLE WITH
LOGIN PASSWORD flips them to LOGIN and sets the password atomically;
running this command repeatedly rotates passwords.
"""

from __future__ import annotations

import secrets

import click
import keyring
import psycopg
from psycopg import sql

from .db import build_role_dsn, connect, get_dsn, parse_dsn

KEYCHAIN_SERVICE = "scrollantir"

# (postgres role name, Keychain account name)
# Keychain account names are contractually exact: the Mac forwarder,
# Swift app, and edge functions read by these literal strings.
ROLES: tuple[tuple[str, str], ...] = (
    ("ingest_role", "ingest-role"),
    ("user_role", "user-role"),
    ("agent_role", "agent-role"),
)


def setup_roles() -> None:
    parts = parse_dsn(get_dsn())

    # Stage the rotation in one DB transaction. Keychain writes happen
    # ONLY after the DB transaction commits, so a mid-rotation failure
    # rolls back every password and leaves Keychain untouched.
    pending: list[tuple[str, str, str]] = []   # (role, keychain_account, role_dsn)
    with connect() as conn, conn.cursor() as cur:
        for role, keychain_account in ROLES:
            password = secrets.token_urlsafe(32)
            try:
                cur.execute(
                    sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {}").format(
                        sql.Identifier(role), sql.Literal(password)
                    )
                )
            except psycopg.errors.UndefinedObject:
                raise click.ClickException(
                    f"role '{role}' does not exist. "
                    f"Run: supabase db push --include-roles"
                )
            role_dsn = build_role_dsn(role, password, parts)
            pending.append((role, keychain_account, role_dsn))
    # DB committed here. Now write to Keychain.

    results: list[tuple[str, str, str]] = []
    for role, keychain_account, role_dsn in pending:
        keyring.set_password(KEYCHAIN_SERVICE, keychain_account, role_dsn)
        results.append((role, keychain_account, role_dsn))

    click.echo()
    for role, acct, _ in results:
        click.echo(f"  ✓ {role:<12} → keychain: {KEYCHAIN_SERVICE}/{acct}")
    click.echo()

    ingest_dsn = next(dsn for role, _, dsn in results if role == "ingest_role")
    click.echo("Next: set the ingest_role URL as a Supabase function secret:")
    click.echo(f"  supabase secrets set INGEST_DATABASE_URL='{ingest_dsn}'")
    click.echo()
    click.echo(
        "user-role and agent-role URLs are in the Keychain and are read "
        "directly by the Mac dashboard and local Claude Code agent."
    )
