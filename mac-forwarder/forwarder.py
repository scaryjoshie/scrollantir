"""
Scrollantir Mac forwarder.

Reads ActivityWatch via its local HTTP API (`aw-client` talks to
aw-server on 127.0.0.1:5600), maps per-bucket events to scrollantir
events, POSTs batches to the ingest server with bearer auth, and
advances a per-bucket checkpoint.

Run under launchd every 30s. See `com.scrollantir.forwarder.plist`
and `setup.sh`.

Design notes:
- Event UUIDs are
    uuid5(NAMESPACE_URL,
          f"mac:{source}:{bucket_created_at}:{aw_event.id}")
  Rationale: retries must produce the same UUID so the server
  dedupes via `ON CONFLICT (id)`. An earlier scheme used the full
  AW `bucket_id` as the UUID input, which includes the DHCP-
  assigned hostname — so joining a different Wi-Fi network
  produced fresh UUIDs for events that otherwise shared identity.
  Current scheme swaps hostname out for `bucket_created_at` (stable
  across a bucket's lifetime; changes only when AW recreates it,
  e.g. on DB wipe) plus the scrollantir source name. Hostname
  drift dedupes correctly; AW DB rebuild gets a new generation of
  UUIDs so aw_ids that restart at 1 don't collide with old.
- Checkpoint is keyed by AW bucket_id (unchanged from earlier
  forwarder versions). Each entry also carries `source` and
  `bucket_created_at` so we can detect bucket rebuilds (same
  bucket_id, new created timestamp → reset id=0) and so the UUID
  input has everything it needs. Legacy checkpoint entries (from
  before this refactor) fill these in on first drain.
- We drain EVERY AW bucket that prefix-matches a known source —
  not just the newest. If hostname drift created a second bucket
  for the same source, both get drained; their events live under
  different `bucket_created_at` → different UUIDs → no collisions
  in Supabase.
- On any error (4xx / 5xx / network), we do NOT advance the
  checkpoint. Next run retries from the same point. Launchd
  re-fires every 30s.
- We rely on aw-server running on localhost:5600. If it's down,
  watchers queue locally (AW's own persist-queue) and drain when
  it comes back. No events are lost.
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


# Checkpoint format:
#   { "<aw_bucket_id>": {
#         "source": "<scrollantir source>",
#         "bucket_created_at": "<ISO-8601 UTC>" | null,
#         "id": <int>,
#         "ts": "<ISO-8601 UTC>"
#       } }
# Legacy format (pre-refactor):
#   { "<aw_bucket_id>": {"id": <int>, "ts": <ISO>} }
# Migration fills in `source` from prefix-match and leaves
# `bucket_created_at` as null; first drain fetches the value from
# AW and writes it in.

def load_checkpoint() -> dict[str, dict]:
    if not CHECKPOINT_PATH.exists():
        return {}
    try:
        with CHECKPOINT_PATH.open() as f:
            raw = json.load(f)
    except json.JSONDecodeError as e:
        err(f"checkpoint file corrupt ({e}); starting from scratch")
        return {}
    out: dict[str, dict] = {}
    for bucket_id, v in raw.items():
        if not isinstance(v, dict) or "id" not in v or "ts" not in v:
            continue
        source = v.get("source") or source_for_bucket(bucket_id)
        if source is None:
            # Unrecognized bucket prefix — keep the raw entry as-is
            # rather than dropping, so a future prefix addition can
            # pick it up.
            out[bucket_id] = {**v}
            continue
        out[bucket_id] = {
            "source": source,
            "bucket_created_at": v.get("bucket_created_at"),
            "id": int(v["id"]),
            "ts": str(v["ts"]),
        }
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
    return (
        dt.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _normalize_created(bucket_created) -> str:
    """Canonicalize AW's `created` value to a stable ISO-8601 UTC
    string suitable for use as UUID input. Fails loudly on
    unparseable inputs so UUIDs can never drift silently.

    - aware datetime → converted to UTC, ms-precision ISO
    - naive datetime → assumed UTC, attached tzinfo, normalized
    - ISO-8601 string (with Z or offset) → parsed + normalized
    - naive ISO string → assumed UTC → normalized
    - anything else → ValueError
    """
    if isinstance(bucket_created, datetime):
        dt = bucket_created
    else:
        s = str(bucket_created)
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError as e:
            raise ValueError(
                f"cannot parse bucket_created {bucket_created!r}: {e}"
            ) from None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return iso_z(dt)


def build_event(source: str, bucket_created_iso: str, aw_event) -> dict:
    ev_id = str(uuid.uuid5(
        NAMESPACE,
        f"mac:{source}:{bucket_created_iso}:{aw_event.id}",
    ))
    return {
        "id": ev_id,
        "device": "mac",
        "source": source,
        "timestamp": iso_z(aw_event.timestamp),
        "duration_s": round(aw_event.duration.total_seconds(), 3),
        "data": shape_data(source, dict(aw_event.data)),
    }


def _collapse_overlaps(events: list) -> list:
    """Drop events whose time span is strictly contained by another
    same-data event in the batch. Targets the aw-server heartbeat
    cascade, where the watcher's heartbeat pulse produces a chain
    of retroactive rows (timestamps step +1 μs backward, durations
    grow) — all with the same `data` payload but distinct aw_ids.
    Each cascade row's span is nested inside the next one's, so a
    strict-containment filter reduces the cluster to one winner
    (the longest-duration row).

    Does NOT touch:
      - events with different `data` payloads (different activity
        contexts)
      - events with the same `data` but partially-overlapping spans
        that don't strictly contain each other (two legitimate
        same-activity events adjacent in time)
    """
    if len(events) < 2:
        return events

    from collections import defaultdict
    groups: dict[str, list] = defaultdict(list)
    for e in events:
        key = json.dumps(dict(e.data), sort_keys=True, default=str)
        groups[key].append(e)

    survivors = []
    for group in groups.values():
        if len(group) == 1:
            survivors.append(group[0])
            continue
        # Consider candidates longest-first so the nested cascade
        # rows (shorter, contained) get discarded against the
        # longest one already kept.
        group.sort(key=lambda e: (-e.duration.total_seconds(), -e.id))
        kept: list = []
        for candidate in group:
            c_start = candidate.timestamp
            c_end = c_start + candidate.duration
            contained = any(
                k.timestamp <= c_start
                and k.timestamp + k.duration >= c_end
                and k.id != candidate.id
                for k in kept
            )
            if not contained:
                kept.append(candidate)
        survivors.extend(kept)

    survivors.sort(key=lambda e: e.id)
    return survivors


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
            "User-Agent": "scrollantir-mac-forwarder/3",
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
    bucket_created_iso: str,
    cp: dict | None,
    ingest_url: str,
    token: str,
) -> tuple[int, dict | None]:
    """Fetch new events for one bucket, POST in ≤500-chunks, return
    (events_sent, new_checkpoint_entry_or_None).

    Forwards only *sealed* events: the newest event per bucket is
    held back every run because AW heartbeats it until focus
    changes, and shipping it mid-growth would freeze its duration
    at a snapshot (this bug dropped ~93% of mac activity before
    catch; see docs/sessions/session-2026-04-23-aw-forwarder.md). Once a
    newer-id sibling appears, the previously-held event is sealed
    at its final duration and gets forwarded on the next drain.

    Raises IngestError on network/HTTP failure — caller decides
    whether to bail the whole run.
    """
    # Detect bucket rebuild (same aw_bucket_id but AW recreated the
    # bucket — e.g., DB wipe). Under the new UUID scheme the
    # rebuilt bucket's events hash into a distinct generation, so
    # resetting id=0 is safe: fresh aw_ids won't collide with old
    # on the server.
    stored_created = cp.get("bucket_created_at") if cp else None
    if stored_created is not None and stored_created != bucket_created_iso:
        log(
            f"{bucket_id}: AW rebuilt bucket "
            f"(was {stored_created}, now {bucket_created_iso}); "
            f"resetting id=0"
        )
        cp = None

    cp = cp or {"source": source, "bucket_created_at": None, "id": 0, "ts": EPOCH_ISO}
    last_id = cp["id"]
    last_ts = datetime.fromisoformat(cp["ts"].replace("Z", "+00:00"))

    aw_events = aw.get_events(bucket_id, start=last_ts, limit=-1)
    fresh = sorted(
        (e for e in aw_events if e.id > last_id),
        key=lambda e: e.id,
    )

    if not fresh:
        # Fill in bucket_created_at on migrated or fresh entries so
        # the next run's rebuild-detector has something to compare
        # against. Only rewrite if the field actually changed.
        if cp.get("bucket_created_at") != bucket_created_iso:
            return 0, {
                "source": source,
                "bucket_created_at": bucket_created_iso,
                "id": cp["id"],
                "ts": cp["ts"],
            }
        return 0, None

    # FU-2: collapse AW heartbeat cascades — each focus period can
    # emit a chain of same-data rows with nested spans; keep the
    # longest survivor per group.
    before = len(fresh)
    fresh = _collapse_overlaps(fresh)
    collapsed = before - len(fresh)
    if collapsed > 0:
        log(
            f"{bucket_id}: collapsed {collapsed} same-data "
            f"overlapping events ({before} → {len(fresh)})"
        )

    # Hold back the newest survivor. AW is still heartbeating the
    # current focus event, so shipping it now would freeze its
    # duration mid-growth. Next poll re-reads it (checkpoint stays
    # below tail.id) and forwards it once a newer event seals it.
    tail = fresh[-1]
    to_forward = fresh[:-1]

    if not to_forward:
        # Only the tail exists this run; nothing sealed yet. Keep
        # the checkpoint below tail.id so we re-read next poll.
        return 0, {
            "source": source,
            "bucket_created_at": bucket_created_iso,
            "id": tail.id - 1,
            "ts": cp["ts"],
        }

    for chunk_start in range(0, len(to_forward), BATCH_SIZE):
        chunk = to_forward[chunk_start:chunk_start + BATCH_SIZE]
        payload = [build_event(source, bucket_created_iso, e) for e in chunk]
        post_batch(ingest_url, token, payload)

    # Advance checkpoint to just below tail.id so the held tail is
    # re-read next run. min(tail.ts, max_forwarded_ts) guards
    # against the backward-stepping cascade timestamps noted in
    # _collapse_overlaps.
    max_forwarded_ts = max(e.timestamp for e in to_forward)
    new_cp = {
        "source": source,
        "bucket_created_at": bucket_created_iso,
        "id": tail.id - 1,
        "ts": iso_z(min(tail.timestamp, max_forwarded_ts)),
    }
    return len(to_forward), new_cp


def run_once() -> int:
    cfg = load_config()
    # Backwards-compat: older configs used `server_url`.
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
    bucket_count = 0
    for bucket_id in sorted(buckets.keys()):
        source = source_for_bucket(bucket_id)
        if source is None:
            continue
        meta = buckets[bucket_id]
        created_raw = meta.get("created") if isinstance(meta, dict) else getattr(meta, "created", None)
        if created_raw is None:
            err(f"{bucket_id}: bucket metadata missing `created`; skipping")
            continue
        try:
            bucket_created_iso = _normalize_created(created_raw)
        except ValueError as e:
            err(f"{bucket_id}: {e}; skipping")
            continue

        bucket_count += 1
        cp = checkpoint.get(bucket_id)
        try:
            sent, new_cp = drain_bucket(
                aw, bucket_id, source, bucket_created_iso, cp, ingest_url, token,
            )
        except IngestError as e:
            if 400 <= e.status < 500 and e.status not in (408, 429):
                err(f"{bucket_id}: ingest rejected ({e}); checkpoint unchanged")
            else:
                err(f"{bucket_id}: transient ({e}); checkpoint unchanged")
            return 1
        if new_cp is None:
            continue
        checkpoint[bucket_id] = new_cp
        save_checkpoint(checkpoint)
        total += sent
        if sent > 0:
            log(f"{bucket_id}: sent {sent} events (through id {new_cp['id']})")

    if total == 0:
        log("no new events")
    else:
        log(f"run complete: {total} events across {bucket_count} buckets")
    return 0


def main() -> int:
    start = time.monotonic()
    rc = run_once()
    log(f"exit={rc} elapsed_s={time.monotonic() - start:.2f}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
