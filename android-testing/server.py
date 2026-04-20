"""
Scrollantir stub ingest server.

Receives batches of events from the Android app (and eventually the Mac
forwarder), validates a bearer token, logs everything to stdout, and appends
to a daily .jsonl file. No DB, no dedup, no real auth scheme — this is a
development placeholder for Stage 3 LAN testing only.

Run:
    pip install fastapi uvicorn
    SCROLLANTIR_TOKEN=dev-token python server.py

Then from the phone, POST to http://<mac-lan-ip>:8000/ingest with
    Authorization: Bearer dev-token
"""
from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

TOKEN = os.environ.get("SCROLLANTIR_TOKEN", "dev-token")
LOG_DIR = Path(__file__).parent / "received"
LOG_DIR.mkdir(exist_ok=True)

app = FastAPI(title="scrollantir-stub")


class Event(BaseModel):
    id: str
    device: str
    source: str
    timestamp: str
    duration_s: float
    data: dict


@app.get("/")
async def hello():
    return {"status": "ok", "app": "scrollantir-stub"}


@app.post("/ingest")
async def ingest(events: list[Event], authorization: str = Header(...)):
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    token = authorization[len("Bearer "):]
    if not secrets.compare_digest(token, TOKEN):
        raise HTTPException(401, "bad token")

    print(f"[ingest] received {len(events)} events")
    for e in events:
        # Pretty-print: prefer app_label over the raw package name when the
        # client included one. Keeps the raw `app` field in data for
        # completeness.
        label = e.data.get("app_label") or e.data.get("app") or ""
        if label and label != str(e.data):
            extras = {k: v for k, v in e.data.items() if k not in ("app", "app_label")}
            suffix = f"  {label}" + (f"  {extras}" if extras else "")
        else:
            suffix = f"  data={e.data}"
        print(
            f"  {e.device:6} {e.source:28} {e.duration_s:7.2f}s  "
            f"id={e.id[:8]}{suffix}"
        )

    # Append to daily rollup file
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log_file = LOG_DIR / f"{today}.jsonl"
    with log_file.open("a") as f:
        for e in events:
            f.write(json.dumps(e.model_dump()) + "\n")

    return {"ok": True, "count": len(events)}


if __name__ == "__main__":
    import uvicorn
    print("─" * 60)
    print(f"  scrollantir stub — listening on 0.0.0.0:8069")
    print(f"  token:    {TOKEN}")
    print(f"  log dir:  {LOG_DIR}")
    print("─" * 60, flush=True)
    uvicorn.run(app, host="0.0.0.0", port=8069, log_level="info")
