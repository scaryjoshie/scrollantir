"""
Scrollantir Mac forwarder.

Reads ActivityWatch via its local HTTP API (`aw-client` talks to
aw-server on 127.0.0.1:5600), maps per-bucket events to scrollantir
events, POSTs batches to the ingest server with bearer auth, and
advances a per-bucket (event-id, timestamp) checkpoint.

Run under launchd every 30s. See `com.scrollantir.forwarder.plist`
and `setup.sh`.

Design notes:
- Event UUIDs are uuid5(NAMESPACE_URL, f"{aw_bucket_id}:{aw_event_id}")
  so retries produce the same ID and the server dedupes via ON CONFLICT.
- We checkpoint on (ts, id). `ts` bounds the API fetch (cheap filter
  that scales with backfill size rather than total history); `id`
  dedupes within same-timestamp collisions and is what the uuid5 is
  keyed on.
- On any error (4xx / 5xx / network), we do NOT advance the checkpoint.
  Next run retries from the same point. On bad token we exit 1; launchd
  still re-fires every 30s, so the pace of retry is 2 req/min/bucket —
  not a storm, but not zero either.
- We rely on aw-server running on localhost:5600. If it's down,
  watchers queue locally (AW's own persist-queue) and drain when it
  comes back. No events are lost.
- `Event.id` is assumed unique per bucket for the lifetime of AW's
  SQLite file. If a user deletes and recreates a bucket, ids restart
  from 1 and this checkpoint's stored id would be larger than the new
  events' ids → those events would be skipped. Not worth defending
  against in code; delete the checkpoint file if you ever wipe AW.
"""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from aw_client import ActivityWatchClient

try:
    import keyring
except ImportError:
    keyring = None

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("SCROLLANTIR_CONFIG_DIR", str(HOME / ".scrollantir")))
CONFIG_PATH = CONFIG_DIR / "config.json"
CHECKPOINT_PATH = CONFIG_DIR / "checkpoint.json"

KEYRING_SERVICE = "scrollantir"
KEYRING_KEY = "ingest-token"

BATCH_SIZE = 500
HTTP_TIMEOUT_S = 20

# AW bucket-name prefix → scrollantir source.
# AW suffixes bucket IDs with `_<hostname>`, so prefix-match.
BUCKET_PREFIX_TO_SOURCE = [
    ("aw-watcher-window",      "system.window"),
    ("aw-watcher-afk",         "system.afk"),
    ("aw-watcher-web-firefox", "zen.tab"),
]


# ─── logging ──────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{ts} {msg}", flush=True)


def err(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{ts} ERROR {msg}", file=sys.stderr, flush=True)


# ─── config + state ───────────────────────────────────────────────────────

def load_config() -> dict:
    if not CONFIG_PATH.exists():
        err(f"missing config at {CONFIG_PATH} — run mac-forwarder/setup.sh")
        sys.exit(2)
    with CONFIG_PATH.open() as f:
        return json.load(f)


def load_token() -> str:
    if keyring is not None:
        try:
            tok = keyring.get_password(KEYRING_SERVICE, KEYRING_KEY)
            if tok:
                return tok
        except Exception as e:
            err(f"keyring read failed: {e}")
    tok = os.environ.get("SCROLLANTIR_TOKEN")
    if tok:
        return tok
    err("no ingest token in keychain or SCROLLANTIR_TOKEN — run setup.sh")
    sys.exit(2)


def load_checkpoint() -> dict[str, dict]:
    """Per-bucket {id: int, ts: ISO-8601 str}."""
    if not CHECKPOINT_PATH.exists():
        return {}
    try:
        with CHECKPOINT_PATH.open() as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        err(f"checkpoint file corrupt ({e}); starting from scratch")
        return {}
    return {
        bucket: {"id": int(v["id"]), "ts": str(v["ts"])}
        for bucket, v in data.items()
        if isinstance(v, dict) and "id" in v and "ts" in v
    }


def save_checkpoint(cp: dict[str, dict]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CHECKPOINT_PATH.with_suffix(".json.tmp")
    with tmp.open("w") as f:
        json.dump(cp, f, indent=2, sort_keys=True)
    tmp.replace(CHECKPOINT_PATH)


# ─── source mapping + event shaping ───────────────────────────────────────

def source_for_bucket(bucket_id: str) -> str | None:
    for prefix, src in BUCKET_PREFIX_TO_SOURCE:
        if bucket_id.startswith(prefix):
            return src
    return None


NAMESPACE = uuid.NAMESPACE_URL


def iso_z(dt: datetime) -> str:
    return (
        dt.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def build_event(bucket_id: str, source: str, aw_event) -> dict:
    ev_id = str(uuid.uuid5(NAMESPACE, f"{bucket_id}:{aw_event.id}"))
    return {
        "id": ev_id,
        "device": "mac",
        "source": source,
        "timestamp": iso_z(aw_event.timestamp),
        "duration_s": round(aw_event.duration.total_seconds(), 3),
        "data": shape_data(source, dict(aw_event.data)),
    }


def shape_data(source: str, data: dict) -> dict:
    if source == "system.window":
        return {"app": data.get("app", ""), "title": data.get("title", "")}
    if source == "system.afk":
        return {"status": data.get("status", "")}
    if source == "zen.tab":
        url = data.get("url", "")
        if "?" in url:
            url = url.split("?", 1)[0]
        return {
            "url": url,
            "title": data.get("title", ""),
            "container": data.get("container", "no-container"),
            "audible": bool(data.get("audible", False)),
            "incognito": bool(data.get("incognito", False)),
        }
    return dict(data)


# ─── ingest ───────────────────────────────────────────────────────────────

class IngestError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"HTTP {status}: {body[:200]}")
        self.status = status
        self.body = body


def post_batch(ingest_url: str, token: str, events: list[dict]) -> None:
    req = Request(
        ingest_url,
        data=json.dumps(events).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "scrollantir-mac-forwarder/2",
        },
    )
    try:
        with urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            resp.read()
    except HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise IngestError(e.code, body) from None
    except URLError as e:
        raise IngestError(0, f"network: {e.reason}") from None


# ─── main loop ────────────────────────────────────────────────────────────

EPOCH_ISO = "1970-01-01T00:00:00Z"


def drain_bucket(
    aw: ActivityWatchClient,
    bucket_id: str,
    source: str,
    cp: dict | None,
    ingest_url: str,
    token: str,
) -> tuple[int, dict | None]:
    """Fetch new events for one bucket, POST in ≤500-chunks, return
    (events_sent, new_checkpoint_entry_or_None).

    Raises IngestError on network/HTTP failure — caller decides whether to
    bail the whole run (we do, so the next launchd tick retries).
    """
    cp = cp or {"id": 0, "ts": EPOCH_ISO}
    last_id = cp["id"]
    last_ts = datetime.fromisoformat(cp["ts"].replace("Z", "+00:00"))

    # Pull everything since last_ts. aw-client returns newest-first.
    # On a 30s cadence this is a handful of events in steady state; on
    # a long backfill it's bounded by how long the forwarder was down.
    aw_events = aw.get_events(bucket_id, start=last_ts, limit=-1)
    fresh = sorted(
        (e for e in aw_events if e.id > last_id),
        key=lambda e: e.id,
    )
    if not fresh:
        return 0, None

    for chunk_start in range(0, len(fresh), BATCH_SIZE):
        chunk = fresh[chunk_start:chunk_start + BATCH_SIZE]
        payload = [build_event(bucket_id, source, e) for e in chunk]
        post_batch(ingest_url, token, payload)

    # fresh is sorted ascending by id, so fresh[-1].id is the new high-water.
    # Timestamp is NOT monotonic with id (watchers can emit for a past moment),
    # so take an actual max across the batch.
    new_cp = {
        "id": fresh[-1].id,
        "ts": iso_z(max(e.timestamp for e in fresh)),
    }
    return len(fresh), new_cp


def run_once() -> int:
    cfg = load_config()
    # Backwards-compat: older configs used `server_url` (base URL;
    # `/ingest` was appended in post_batch). New configs use
    # `ingest_url` (the full endpoint, no appending). Prefer the new
    # key; fall back to the old by appending /ingest.
    ingest_url = cfg.get("ingest_url")
    if not ingest_url:
        legacy = cfg.get("server_url")
        if legacy:
            ingest_url = legacy.rstrip("/") + "/ingest"
        else:
            err("config.json missing 'ingest_url' (or legacy 'server_url')")
            return 2
    aw_host = cfg.get("aw_host", "127.0.0.1")
    aw_port = int(cfg.get("aw_port", 5600))

    token = load_token()
    checkpoint = load_checkpoint()

    aw = ActivityWatchClient(
        "scrollantir-forwarder", host=aw_host, port=aw_port, testing=False,
    )
    try:
        buckets = aw.get_buckets()
    except Exception as e:
        err(f"can't reach aw-server at {aw_host}:{aw_port} ({e}); "
            "is ActivityWatch running?")
        return 1

    total = 0
    for bucket_id in sorted(buckets.keys()):
        source = source_for_bucket(bucket_id)
        if source is None:
            continue
        cp = checkpoint.get(bucket_id)
        try:
            sent, new_cp = drain_bucket(aw, bucket_id, source, cp, ingest_url, token)
        except IngestError as e:
            if 400 <= e.status < 500 and e.status not in (408, 429):
                err(f"{bucket_id}: ingest rejected ({e}); checkpoint unchanged")
            else:
                err(f"{bucket_id}: transient ({e}); checkpoint unchanged")
            return 1
        if sent == 0:
            continue
        checkpoint[bucket_id] = new_cp  # type: ignore[assignment]
        save_checkpoint(checkpoint)
        total += sent
        log(f"{bucket_id}: sent {sent} events (through id {new_cp['id']})")

    if total == 0:
        log("no new events")
    else:
        log(f"run complete: {total} events across {len(buckets)} buckets")
    return 0


def main() -> int:
    start = time.monotonic()
    rc = run_once()
    log(f"exit={rc} elapsed_s={time.monotonic() - start:.2f}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
