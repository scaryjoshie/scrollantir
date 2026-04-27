#!/usr/bin/env python3
"""Scrollantir admin CLI. Device registry, role password setup, and
bearer-token lifecycle.

Invoke via the repo-root `./admin` shim (which uses the scripts/.venv
interpreter) rather than running this module directly.
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import click  # noqa: E402

from admin import devices as devices_mod  # noqa: E402
from admin import local as local_mod  # noqa: E402
from admin import roles as roles_mod  # noqa: E402
from admin import tokens as tokens_mod  # noqa: E402


@click.group(context_settings={"help_option_names": ["-h", "--help"]})
def cli() -> None:
    """Scrollantir admin CLI."""


# ── device subgroup ────────────────────────────────────────────────

@cli.group()
def device() -> None:
    """Device registry (public.devices)."""


@device.command("add")
@click.argument("device_id")
@click.option("--label", required=True, help="Human-readable device name.")
@click.option(
    "--platform",
    required=True,
    type=click.Choice(devices_mod.VALID_PLATFORMS),
)
@click.option("--note", default=None)
def device_add(device_id: str, label: str, platform: str, note: str | None) -> None:
    """Register a new device. device_id is the immutable stable key."""
    devices_mod.add(device_id, label, platform, note)


@device.command("list")
def device_list() -> None:
    """List all devices."""
    devices_mod.list_devices()


@device.command("rename")
@click.argument("device_id")
@click.option("--label", required=True)
def device_rename(device_id: str, label: str) -> None:
    """Change a device's display label. No auth impact."""
    devices_mod.rename(device_id, label)


@device.command("retire")
@click.argument("device_id")
def device_retire(device_id: str) -> None:
    """Mark a device retired. accept_event rejects future events for it."""
    devices_mod.retire(device_id)


# ── role + token commands ──────────────────────────────────────────

@cli.command("setup-roles")
def setup_roles_cmd() -> None:
    """Assign passwords to ingest_role / user_role / agent_role and
    write per-role connection strings to the macOS Keychain."""
    roles_mod.setup_roles()


@cli.command()
@click.option("--device-id", required=True)
@click.option("--note", default=None)
@click.option(
    "--show-token",
    is_flag=True,
    help="Also print plaintext (default: prefix only).",
)
def mint(device_id: str, note: str | None, show_token: bool) -> None:
    """Mint a new bearer token for a device."""
    tokens_mod.mint(device_id, note, show_token)


@cli.command("list")
def list_cmd() -> None:
    """List all tokens (active, superseded, revoked)."""
    tokens_mod.list_tokens()


@cli.command()
@click.option("--prefix", required=True, help="8-char token prefix.")
def revoke(prefix: str) -> None:
    """Revoke a single token by prefix. Fails on 0 or >1 matches."""
    tokens_mod.revoke(prefix)


@cli.command("revoke-all")
@click.option("--device-id", required=True)
@click.option(
    "--yes",
    is_flag=True,
    help="Required confirmation flag (footgun guard).",
)
def revoke_all_cmd(device_id: str, yes: bool) -> None:
    """Revoke every non-revoked token for a device at once."""
    tokens_mod.revoke_all(device_id, yes)


@cli.command()
@click.option("--device-id", required=True)
@click.option(
    "--finalize",
    is_flag=True,
    help="Revoke superseded tokens for this device now (instead of minting).",
)
def rotate(device_id: str, finalize: bool) -> None:
    """Supersede current tokens and mint a fresh one (48h grace), or
    --finalize to revoke superseded tokens immediately. Rotation always
    prints plaintext — the new token needs to reach the device."""
    tokens_mod.rotate(device_id, finalize)


# ── local self-hosted runtime/ stack subgroup ──────────────────────
#
# Parallel commands for the new self-hosted backend (runtime/ folder).
# Different DSN, different schema. Eventually replaces the Supabase-
# pointed commands above; for now they coexist during cutover.

@cli.group()
def local() -> None:
    """Operations against the local self-hosted runtime/ stack."""


@local.command("mint")
@click.option("--device-id", required=True,
              type=click.Choice(["phone", "mac", "cloud", "prompt"]))
@click.option("--ingest-url", default=None,
              help="Override (defaults to $SCROLLANTIR_INGEST_URL).")
@click.option("--show-token", is_flag=True,
              help="Also print plaintext (default: prefix + QR only).")
def local_mint(device_id: str, ingest_url: str | None, show_token: bool) -> None:
    """Mint a bearer token for a device on the local stack."""
    local_mod.mint(device_id, ingest_url, show_token)


@local.command("list")
def local_list() -> None:
    """List tokens on the local stack."""
    local_mod.list_tokens()


@local.command("revoke")
@click.option("--prefix", required=True, help="8-char token prefix.")
def local_revoke(prefix: str) -> None:
    """Revoke a token by prefix on the local stack."""
    local_mod.revoke(prefix)


if __name__ == "__main__":
    cli()
