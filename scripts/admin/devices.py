"""Device registry commands: add, list, rename, retire."""

from __future__ import annotations

import click
import psycopg

from . import fmt_ts, print_table
from .db import connect

VALID_PLATFORMS = ("macos", "android", "ios", "linux")


def add(device_id: str, label: str, platform: str, note: str | None) -> None:
    if platform not in VALID_PLATFORMS:
        raise click.ClickException(
            f"platform must be one of: {', '.join(VALID_PLATFORMS)}"
        )
    try:
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO public.devices (device_id, label, platform, note) "
                "VALUES (%s, %s, %s, %s)",
                (device_id, label, platform, note),
            )
    except psycopg.errors.UniqueViolation:
        raise click.ClickException(f"device '{device_id}' already exists")
    click.echo(f"Added device '{device_id}' ({label}, {platform}).")


def list_devices() -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT device_id, label, platform, created_at, retired_at, note "
            "FROM public.devices ORDER BY created_at ASC"
        )
        rows = cur.fetchall()
    if not rows:
        click.echo("(no devices)")
        return
    table_rows = [
        (
            device_id,
            label,
            platform,
            fmt_ts(created_at),
            fmt_ts(retired_at),
            note or "",
        )
        for device_id, label, platform, created_at, retired_at, note in rows
    ]
    print_table(
        ("DEVICE_ID", "LABEL", "PLATFORM", "CREATED", "RETIRED", "NOTE"),
        table_rows,
    )


def rename(device_id: str, label: str) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE public.devices SET label = %s WHERE device_id = %s",
            (label, device_id),
        )
        if cur.rowcount == 0:
            raise click.ClickException(f"device '{device_id}' not found")
    click.echo(f"Renamed '{device_id}' to '{label}'.")


def retire(device_id: str) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE public.devices SET retired_at = NOW() "
            "WHERE device_id = %s AND retired_at IS NULL",
            (device_id,),
        )
        if cur.rowcount == 0:
            raise click.ClickException(
                f"device '{device_id}' not found or already retired"
            )
    click.echo(f"Retired '{device_id}'. Historical events are preserved.")
