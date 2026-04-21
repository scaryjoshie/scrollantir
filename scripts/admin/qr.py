"""Terminal QR rendering for mint payloads."""

from __future__ import annotations

import qrcode


def render(data: str) -> None:
    q = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        border=1,
    )
    q.add_data(data)
    q.make(fit=True)
    q.print_ascii(invert=True)
