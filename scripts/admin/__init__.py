"""Scrollantir admin CLI implementation package."""

from __future__ import annotations

import click


def fmt_ts(ts) -> str:
    if ts is None:
        return "—"
    return ts.astimezone().strftime("%Y-%m-%d %H:%M")


def print_table(headers: tuple[str, ...], rows: list[tuple]) -> None:
    widths = [len(h) for h in headers]
    str_rows = [tuple(("" if c is None else str(c)) for c in r) for r in rows]
    for r in str_rows:
        for i, cell in enumerate(r):
            widths[i] = max(widths[i], len(cell))
    fmt = "  ".join(f"{{:<{w}}}" for w in widths)
    click.echo(fmt.format(*headers))
    for r in str_rows:
        click.echo(fmt.format(*r))
