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
  Next run retries from the same point. On bad token we log and exit —
  launchd fires us again in 30s, so no retry storm.
- We rely on aw-server running on localhost:5600. If it's down,
  watchers queue locally (AW's own persist-queue) and drain when it
  comes back. No events are lost.
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
    out: dict[str, dict] = {}
    for bucket, v in data.items():
        # Upgrade legacy scalar format ({bucket: int}) if any checkpoint
        # files from before the aw-client refactor survive.
        if isinstance(v, int):
            out[bucket] = {"id": v, "ts": "1970-01-01T00:00:00Z"}
        elif isinstance(v, dict) and "id" in v and "ts" in v:
            out[bucket] = {"id": int(v["id"]), "ts": str(v["ts"])}
    return out


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
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


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


def post_batch(server_url: str, token: str, events: list[dict]) -> None:
    req = Request(
        server_url.rstrip("/") + "/ingest",
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

def drain_bucket(
    aw: ActivityWatchClient,
    bucket_id: str,
    source: str,
    cp: dict,
    server_url: str,
    token: str,
) -> tuple[int, dict | None]:
    """Fetch new events for one bucket, POST in ≤500-chunks, return
    (events_sent, new_checkpoint_entry_or_None).

    Raises IngestError on network/HTTP failure — caller decides whether to
    bail the whole run (we do, so the next launchd tick retries).
    """
    last_id = cp["id"] if cp else 0
    last_ts_str = cp["ts"] if cp else "1970-01-01T00:00:00Z"
    last_ts = datetime.fromisoformat(last_ts_str.replace("Z", "+00:00"))

    # Pull everything since last_ts. aw-client returns newest-first.
    # On a 30s cadence this is a handful of events in steady state; on
    # a long backfill it's bounded by how long the forwarder was down.
    aw_events = aw.get_events(bucket_id, start=last_ts, limit=-1)
    fresh = [e for e in aw_events if e.id > last_id]
    if not fresh:
        return 0, None
    fresh.sort(key=lambda e: e.id)

    sent = 0
    new_max_id = last_id
    new_max_ts = last_ts
    for chunk_start in range(0, len(fresh), BATCH_SIZE):
        chunk = fresh[chunk_start:chunk_start + BATCH_SIZE]
        payload = [build_event(bucket_id, source, e) for e in chunk]
        post_batch(server_url, token, payload)
        sent += len(chunk)
        new_max_id = max(new_max_id, max(e.id for e in chunk))
        new_max_ts = max(new_max_ts, max(e.timestamp for e in chunk))

    return sent, {"id": new_max_id, "ts": iso_z(new_max_ts)}


def run_once() -> int:
    cfg = load_config()
    server_url = cfg.get("server_url")
    if not server_url:
        err("config.json missing 'server_url'")
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
            sent, new_cp = drain_bucket(aw, bucket_id, source, cp, server_url, token)
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
