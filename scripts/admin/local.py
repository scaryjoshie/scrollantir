"""Local-stack admin ops for the runtime/ self-hosted backend.

Parallel to admin/tokens.py + admin/devices.py but talks to the new
runtime Postgres (no Supabase pooler shenanigans). Schema differs:

  - private.tokens.token_hash is BYTEA (was TEXT hex)
  - private.tokens column is `prefix` (was `token_prefix`)
  - private.tokens has no `note` or `superseded_at` columns
  - public.devices PK is `id` (was `device_id`); no `retired_at`

DSN resolution: $SCROLLANTIR_LOCAL_DSN.
For the local Mac docker compose stack, expose port 5432 to host first
(add `ports: ["55432:5432"]` to runtime/compose.override.yaml) and set
the DSN to postgresql://scrollantir:<pw>@localhost:55432/scrollantir.

For the Hetzner deploy, ssh into the VM and run from there:
  ssh orch 'cd /opt/scrollantir/repo && ./admin local mint --device-id phone --ingest-url https://...'
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets

import click
import psycopg

from . import qr as qr_module


ENV_DSN = "SCROLLANTIR_LOCAL_DSN"
ENV_INGEST_URL = "SCROLLANTIR_INGEST_URL"


def _connect() -> psycopg.Connection:
    dsn = os.environ.get(ENV_DSN)
    if not dsn:
        raise SystemExit(
            f"No local DSN. Set ${ENV_DSN}, e.g.\n"
            f"  export {ENV_DSN}='postgresql://scrollantir:<pw>@localhost:55432/scrollantir'\n"
            f"For the local Mac stack, expose postgres port 5432 to the\n"
            f"host first (see runtime/compose.override.yaml example)."
        )
    return psycopg.connect(dsn)


def _resolve_ingest_url(override: str | None) -> str:
    url = override or os.environ.get(ENV_INGEST_URL)
    if not url:
        raise SystemExit(
            f"No ingest URL. Pass --ingest-url or set ${ENV_INGEST_URL}.\n"
            f"Example: --ingest-url https://ingest.178-104-253-30.nip.io"
        )
    return url.rstrip("/")


def mint(device_id: str, ingest_url_override: str | None, show_token: bool) -> None:
    """Mint a bearer token for the given device on the local stack.

    Generates 32 random bytes (URL-safe encoded), inserts sha256(plaintext)
    + first-8-char prefix into private.tokens, prints plaintext once
    (gated by --show-token) plus a QR payload that the Android onboarding
    flow can scan to receive {url, token, device_id, label, platform}.
    """
    url = _resolve_ingest_url(ingest_url_override)

    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT label, platform FROM public.devices WHERE id = %s",
            (device_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise click.ClickException(
                f"device '{device_id}' not found in local public.devices.\n"
                f"Expected ids from seed: phone, mac, cloud, prompt."
            )
        label, platform = row

        plaintext = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(plaintext.encode("ascii")).digest()
        prefix = plaintext[:8]

        cur.execute(
            "INSERT INTO private.tokens (device_id, token_hash, prefix) "
            "VALUES (%s, %s, %s)",
            (device_id, token_hash, prefix),
        )

    # QR schema v3 — matches android/.../OnboardScanScreen.kt parser.
    # `device` is canonical; `device_id` legacy alias still accepted by
    # the Android app for transitional compat (we emit canonical only).
    payload = {
        "v": 3,
        "url": url,
        "token": plaintext,
        "device": device_id,
        "label": label,
        "platform": platform,
    }
    click.echo(f"Minted token for device '{device_id}' ({label}).")
    click.echo()
    qr_module.render(json.dumps(payload, separators=(",", ":")))
    click.echo()
    click.echo(f"Prefix:   {prefix}")
    if show_token:
        click.echo(f"Plaintext: {plaintext}")
    click.echo(f"URL:      {url}")
    click.echo()
    click.echo("Next steps:")
    if device_id == "mac":
        click.echo(
            f"  Mac: security add-generic-password -s scrollantir-local "
            f"-a mac -w '<plaintext>'\n"
            f"       (export {ENV_INGEST_URL}={url} in the launchd plist env)"
        )
    elif device_id == "phone":
        click.echo(
            "  Phone: open the Android app's onboarding screen and scan "
            "the QR above."
        )
    else:
        click.echo("  Configure the device with the URL + token above.")


def list_tokens() -> None:
    """List tokens on the local stack."""
    from . import fmt_ts, print_table

    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT device_id,
                   prefix,
                   created_at,
                   last_used_at,
                   CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
                        ELSE 'active' END AS state
            FROM   private.tokens
            ORDER  BY device_id, created_at
            """
        )
        rows = cur.fetchall()
    if not rows:
        click.echo("(no tokens)")
        return
    table = [
        (device_id, prefix, fmt_ts(created), fmt_ts(last_used), state)
        for device_id, prefix, created, last_used, state in rows
    ]
    print_table(("DEVICE", "PREFIX", "CREATED", "LAST_USED", "STATE"), table)


def revoke(prefix: str) -> None:
    """Revoke a single token by prefix on the local stack."""
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM private.tokens "
            "WHERE prefix = %s AND revoked_at IS NULL",
            (prefix,),
        )
        matches = cur.fetchall()
        if len(matches) == 0:
            raise click.ClickException(f"no active token with prefix '{prefix}'")
        if len(matches) > 1:
            raise click.ClickException(
                f"prefix '{prefix}' matches {len(matches)} active tokens; "
                f"use ./admin local list and disambiguate."
            )
        (token_id,) = matches[0]
        cur.execute(
            "UPDATE private.tokens SET revoked_at = NOW() WHERE id = %s",
            (token_id,),
        )
    click.echo(f"Revoked token '{prefix}'.")
