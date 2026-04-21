"""Token lifecycle: mint, list, revoke, revoke-all, rotate.

All token operations go through private.tokens. Plaintext is shown
exactly once (mint / rotate); the DB stores only sha256(plaintext)
and the first 8 chars as a human-friendly prefix.
"""

from __future__ import annotations

import hashlib
import json
import secrets

import click
import psycopg

from . import fmt_ts, print_table, qr as qr_module
from .db import connect, get_dsn, parse_dsn, project_ref


def _ingest_url() -> str:
    parts = parse_dsn(get_dsn())
    return f"https://{project_ref(parts.host)}.supabase.co/functions/v1/ingest"


def _lookup_device(cur, device_id: str) -> tuple[str, str]:
    cur.execute(
        "SELECT label, platform, retired_at "
        "FROM public.devices WHERE device_id = %s",
        (device_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise click.ClickException(
            f"device '{device_id}' not found. "
            f"Run: ./admin device add {device_id} --label ... --platform ..."
        )
    label, platform, retired_at = row
    if retired_at is not None:
        raise click.ClickException(
            f"device '{device_id}' is retired; cannot mint tokens for it"
        )
    return label, platform


def _insert_token(cur, device_id: str, note: str | None) -> tuple[str, str]:
    """Generate, hash, and insert a new token row. Returns (plaintext, prefix)."""
    plaintext = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(plaintext.encode("ascii")).hexdigest()
    token_prefix = plaintext[:8]
    cur.execute(
        "INSERT INTO private.tokens (token_hash, token_prefix, device_id, note) "
        "VALUES (%s, %s, %s, %s)",
        (token_hash, token_prefix, device_id, note),
    )
    return plaintext, token_prefix


def _announce_mint(
    *,
    device_id: str,
    label: str,
    platform: str,
    plaintext: str,
    prefix: str,
    show_token: bool,
    url: str,
) -> None:
    payload = {
        "v": 2,
        "url": url,
        "token": plaintext,
        "device_id": device_id,
        "label": label,
        "platform": platform,
    }
    click.echo(f"Minted token for device '{device_id}' ({label}).")
    click.echo()
    qr_module.render(json.dumps(payload, separators=(",", ":")))
    click.echo()
    click.echo(f"Prefix: {prefix}")
    if show_token:
        click.echo(f"Plaintext: {plaintext}")
    click.echo()
    click.echo(
        "For Mac: re-run mac-forwarder/setup.sh and paste the URL + "
        "token when prompted."
    )
    click.echo(
        "For phone: scan the QR above from the Android app's "
        "'Scan Onboarding QR' button."
    )
    click.echo()
    click.echo(f"URL: {url}")


def mint(device_id: str, note: str | None, show_token: bool) -> None:
    url = _ingest_url()
    with connect() as conn, conn.cursor() as cur:
        label, platform = _lookup_device(cur, device_id)
        plaintext, prefix = _insert_token(cur, device_id, note)
    _announce_mint(
        device_id=device_id,
        label=label,
        platform=platform,
        plaintext=plaintext,
        prefix=prefix,
        show_token=show_token,
        url=url,
    )


def list_tokens() -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT device_id,
                   token_prefix,
                   created_at,
                   last_used_at,
                   CASE
                     WHEN revoked_at    IS NOT NULL THEN 'revoked'
                     WHEN superseded_at IS NOT NULL THEN 'superseded'
                     ELSE 'active'
                   END AS state,
                   note
            FROM   private.tokens
            ORDER  BY device_id ASC, created_at ASC
            """
        )
        rows = cur.fetchall()
    if not rows:
        click.echo("(no tokens)")
        return
    table = [
        (
            device_id,
            prefix,
            fmt_ts(created_at),
            fmt_ts(last_used_at),
            state,
            note or "",
        )
        for device_id, prefix, created_at, last_used_at, state, note in rows
    ]
    print_table(
        ("DEVICE_ID", "PREFIX", "CREATED", "LAST_USED", "STATE", "NOTE"),
        table,
    )


def revoke(prefix: str) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT token_hash FROM private.tokens "
            "WHERE token_prefix = %s AND revoked_at IS NULL",
            (prefix,),
        )
        matches = cur.fetchall()
        if len(matches) == 0:
            raise click.ClickException(
                f"no active token with prefix '{prefix}'"
            )
        if len(matches) > 1:
            raise click.ClickException(
                f"prefix '{prefix}' matches {len(matches)} active tokens; "
                f"refusing to revoke ambiguously. Use `./admin list` and "
                f"disambiguate manually."
            )
        (token_hash,) = matches[0]
        cur.execute(
            "UPDATE private.tokens SET revoked_at = NOW() "
            "WHERE token_hash = %s",
            (token_hash,),
        )
    click.echo(f"Revoked token '{prefix}'.")


def revoke_all(device_id: str, yes: bool) -> None:
    if not yes:
        raise click.ClickException(
            "revoke-all requires --yes (footgun guard). This revokes "
            "EVERY non-revoked token for the device at once."
        )
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE private.tokens SET revoked_at = NOW() "
            "WHERE device_id = %s AND revoked_at IS NULL",
            (device_id,),
        )
        count = cur.rowcount
    click.echo(f"Revoked {count} token(s) for device '{device_id}'.")


def rotate(device_id: str, finalize: bool) -> None:
    if finalize:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE private.tokens SET revoked_at = NOW() "
                "WHERE device_id = %s "
                "  AND superseded_at IS NOT NULL "
                "  AND revoked_at    IS NULL",
                (device_id,),
            )
            count = cur.rowcount
        click.echo(
            f"Finalized rotation for '{device_id}': "
            f"revoked {count} superseded token(s)."
        )
        return

    url = _ingest_url()
    # Supersede + mint in one transaction so we never end up with stale
    # tokens superseded and no new token in place (or vice versa).
    with connect() as conn, conn.cursor() as cur:
        label, platform = _lookup_device(cur, device_id)
        cur.execute(
            "UPDATE private.tokens SET superseded_at = NOW() "
            "WHERE device_id = %s "
            "  AND superseded_at IS NULL "
            "  AND revoked_at    IS NULL",
            (device_id,),
        )
        superseded_count = cur.rowcount
        plaintext, prefix = _insert_token(cur, device_id, note=None)

    click.echo(
        f"Rotated tokens for '{device_id}'. "
        f"Superseded {superseded_count} old token(s); minted 1 new."
    )
    click.echo()
    # Rotation always shows plaintext — the whole point is to hand the
    # new token to the device right now.
    _announce_mint(
        device_id=device_id,
        label=label,
        platform=platform,
        plaintext=plaintext,
        prefix=prefix,
        show_token=True,
        url=url,
    )
    click.echo()
    click.echo(
        f"Old tokens auto-revoke in 48h, or run "
        f"`./admin rotate --device-id {device_id} --finalize` "
        f"to revoke them immediately once the new token is verified flowing."
    )
