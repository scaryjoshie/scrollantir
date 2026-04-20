"""
Scrollantir Mac forwarder.

Reads ActivityWatch's local SQLite read-only, maps per-bucket rows to
scrollantir events, POSTs batches to the ingest server with bearer auth,
and advances a per-bucket rowid checkpoint.

Run under launchd every 30s. See `mac-forwarder/com.scrollantir.forwarder.plist`
and `mac-forwarder/setup.sh`.

Design notes:
- AW owns its SQLite. We open it with `mode=ro` and never mutate.
- Event UUIDs are uuid5(NAMESPACE_URL, f"{aw_bucket_id}:{aw_row_id}") so
  retries produce the same ID and the server dedupes via ON CONFLICT.
- On any error (4xx / 5xx / network), we do NOT advance the checkpoint.
  Next run retries from the same point. On bad token we simply log and
  exit — launchd will wake us 30s later anyway, so no retry storm.
- AW-server-rust (the default as of 2026) stores events with integer
  microsecond `starttime`/`endtime` columns. Older Python aw-server stored
  ISO-8601 `timestamp` + float `duration`. We detect at runtime and adapt.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    import keyring
except ImportError:
    keyring = None

HOME = Path.home()
# Override points for tests; prod runs pick up defaults.
AW_DB = Path(os.environ.get(
    "SCROLLANTIR_AW_DB",
    str(HOME / "Library/Application Support/activitywatch/aw-server-rust/sqlite.db"),
))
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


# ─── config ───────────────────────────────────────────────────────────────

def load_config() -> dict:
    if not CONFIG_PATH.exists():
        err(f"missing config at {CONFIG_PATH} — run mac-forwarder/setup.sh")
        sys.exit(2)
    with CONFIG_PATH.open() as f:
        return json.load(f)


def load_token() -> str:
    # Primary: macOS Keychain via `keyring`.
    if keyring is not None:
        try:
            tok = keyring.get_password(KEYRING_SERVICE, KEYRING_KEY)
            if tok:
                return tok
        except Exception as e:  # keyring backend may be absent in sandbox
            err(f"keyring read failed: {e}")
    # Fallback: env var (for manual debugging only; setup.sh uses keychain).
    tok = os.environ.get("SCROLLANTIR_TOKEN")
    if tok:
        return tok
    err("no ingest token in keychain or SCROLLANTIR_TOKEN — run setup.sh")
    sys.exit(2)


def load_checkpoint() -> dict[str, int]:
    if not CHECKPOINT_PATH.exists():
        return {}
    try:
        with CHECKPOINT_PATH.open() as f:
            data = json.load(f)
        return {k: int(v) for k, v in data.items()}
    except (json.JSONDecodeError, ValueError) as e:
        err(f"checkpoint file corrupt ({e}); starting from scratch")
        return {}


def save_checkpoint(cp: dict[str, int]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CHECKPOINT_PATH.with_suffix(".json.tmp")
    with tmp.open("w") as f:
        json.dump(cp, f, indent=2, sort_keys=True)
    tmp.replace(CHECKPOINT_PATH)


# ─── AW DB access ─────────────────────────────────────────────────────────

@dataclass
class Schema:
    buckets_table: str
    events_table: str
    bucket_key_col: str      # integer PK column on the buckets table
    bucket_id_col: str       # text column with the AW-reported bucket id (e.g. "aw-watcher-window_host")
    event_fk_col: str        # FK on events pointing to buckets.<bucket_key_col>
    time_mode: str           # "rust_int_us" | "rust_int_ns" | "iso_duration"
    ev_start_col: str        # starttime | timestamp
    ev_end_or_dur_col: str   # endtime | duration
    ev_data_col: str         # data | datastr


def detect_schema(conn: sqlite3.Connection) -> Schema:
    """Introspect whichever AW schema variant we've landed on.

    Known variants in the wild as of 2026-04:
      - aw-server-rust (new, current DMG): tables buckets/events,
        events.data column, buckets.name column (text), int nanosecond
        starttime/endtime.
      - aw-server-rust (older): events.datastr column, buckets.id
        (text), int microsecond starttime/endtime.
      - aw-server (python, peewee): bucketmodel/eventmodel, ISO-8601
        timestamp + float duration + datastr.
      - aw-server (python, legacy): bucket/event — same columns as
        peewee variant.
    """
    tabs = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}

    # aw-server-rust variants — match on table names and introspect columns.
    if "buckets" in tabs and "events" in tabs:
        ev_cols = {r[1] for r in conn.execute("PRAGMA table_info(events)")}
        bk_cols = {r[1] for r in conn.execute("PRAGMA table_info(buckets)")}
        if not {"bucketrow", "starttime", "endtime"} <= ev_cols:
            raise RuntimeError(f"unexpected events columns: {ev_cols}")
        data_col = "data" if "data" in ev_cols else "datastr"
        if data_col not in ev_cols:
            raise RuntimeError(f"no data/datastr column on events: {ev_cols}")
        # Bucket text id: `name` in current rust, `id` in older rust.
        # If both present (migration), prefer `name`.
        if "name" in bk_cols and "id" in bk_cols:
            text_col = "name"
        elif "name" in bk_cols:
            text_col = "name"
        elif "id" in bk_cols:
            text_col = "id"
        else:
            raise RuntimeError(f"no bucket name/id column: {bk_cols}")
        key_col = "id" if text_col != "id" else "key"
        if key_col not in bk_cols:
            raise RuntimeError(f"no bucket PK column: {bk_cols}")
        time_mode = _sniff_rust_time_mode(conn)
        return Schema(
            buckets_table="buckets",
            events_table="events",
            bucket_key_col=key_col,
            bucket_id_col=text_col,
            event_fk_col="bucketrow",
            time_mode=time_mode,
            ev_start_col="starttime",
            ev_end_or_dur_col="endtime",
            ev_data_col=data_col,
        )

    # Python aw-server (peewee or legacy).
    for buckets_t, events_t in (("bucketmodel", "eventmodel"), ("bucket", "event")):
        if buckets_t in tabs and events_t in tabs:
            ev_cols = {r[1] for r in conn.execute(f"PRAGMA table_info({events_t})")}
            if {"timestamp", "duration", "bucket_id", "datastr"} <= ev_cols:
                return Schema(
                    buckets_table=buckets_t,
                    events_table=events_t,
                    bucket_key_col="key" if buckets_t == "bucketmodel" else "id",
                    bucket_id_col="id",
                    event_fk_col="bucket_id",
                    time_mode="iso_duration",
                    ev_start_col="timestamp",
                    ev_end_or_dur_col="duration",
                    ev_data_col="datastr",
                )
    raise RuntimeError(
        f"cannot recognise AW schema (tables={sorted(tabs)}); "
        "supported: aw-server-rust (buckets+events) or aw-server python "
        "(bucketmodel+eventmodel or bucket+event)"
    )


def _sniff_rust_time_mode(conn: sqlite3.Connection) -> str:
    """Rust has shipped both microsecond and nanosecond integer timestamps
    in different versions. Peek at one starttime value to decide.
    """
    row = conn.execute("SELECT starttime FROM events LIMIT 1").fetchone()
    if row is None:
        # Empty DB — assume nanoseconds (current rust). First real run
        # will be fine; the forwarder would see no events anyway.
        return "rust_int_ns"
    v = row[0]
    # Year-2001..2262 in ns is ~1e18; in us is ~1e15. Clean split.
    return "rust_int_ns" if v > 10**17 else "rust_int_us"


def list_buckets(conn: sqlite3.Connection, s: Schema) -> list[tuple[Any, str]]:
    """Return [(bucket_rowkey, bucket_text_id)] only for buckets we care about."""
    q = f"SELECT {s.bucket_key_col}, {s.bucket_id_col} FROM {s.buckets_table}"
    out = []
    for key, text_id in conn.execute(q):
        if source_for_bucket(text_id):
            out.append((key, text_id))
    return out


def source_for_bucket(bucket_text_id: str) -> str | None:
    for prefix, src in BUCKET_PREFIX_TO_SOURCE:
        if bucket_text_id.startswith(prefix):
            return src
    return None


def fetch_events(
    conn: sqlite3.Connection,
    s: Schema,
    bucket_key: Any,
    after_row_id: int,
    limit: int,
) -> list[tuple[int, str, float, dict]]:
    """Return [(row_id, iso_timestamp, duration_s, data_dict)] ordered by row_id asc."""
    q = (
        f"SELECT id, {s.ev_start_col}, {s.ev_end_or_dur_col}, {s.ev_data_col} "
        f"FROM {s.events_table} "
        f"WHERE {s.event_fk_col} = ? AND id > ? "
        f"ORDER BY id ASC LIMIT ?"
    )
    rows = []
    for row_id, t_start, t_end_or_dur, data_str in conn.execute(
        q, (bucket_key, after_row_id, limit)
    ):
        if s.time_mode == "rust_int_ns":
            start_dt = datetime.fromtimestamp(t_start / 1e9, tz=timezone.utc)
            duration_s = max(0.0, (t_end_or_dur - t_start) / 1e9)
        elif s.time_mode == "rust_int_us":
            start_dt = datetime.fromtimestamp(t_start / 1e6, tz=timezone.utc)
            duration_s = max(0.0, (t_end_or_dur - t_start) / 1e6)
        else:
            start_dt = _parse_iso(t_start)
            duration_s = float(t_end_or_dur)
        try:
            data = json.loads(data_str) if data_str else {}
        except json.JSONDecodeError:
            data = {}
        rows.append((row_id, _iso_z(start_dt), duration_s, data))
    return rows


def _parse_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso_z(dt: datetime) -> str:
    # Milliseconds, Z suffix — matches the phone's format.
    s = dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"
    return s


# ─── event shaping ────────────────────────────────────────────────────────

NAMESPACE = uuid.NAMESPACE_URL


def build_event(
    bucket_text_id: str,
    source: str,
    row_id: int,
    iso_ts: str,
    duration_s: float,
    data: dict,
) -> dict:
    ev_id = str(uuid.uuid5(NAMESPACE, f"{bucket_text_id}:{row_id}"))
    payload_data = shape_data(source, data)
    return {
        "id": ev_id,
        "device": "mac",
        "source": source,
        "timestamp": iso_ts,
        "duration_s": round(float(duration_s), 3),
        "data": payload_data,
    }


def shape_data(source: str, data: dict) -> dict:
    """Keep only fields the dashboard cares about per source, and sanitise."""
    if source == "system.window":
        return {
            "app": data.get("app", ""),
            "title": data.get("title", ""),
        }
    if source == "system.afk":
        # aw-watcher-afk emits {"status": "afk" | "not-afk"}
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
    url = server_url.rstrip("/") + "/ingest"
    body = json.dumps(events).encode("utf-8")
    req = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "scrollantir-mac-forwarder/1",
        },
    )
    try:
        with urlopen(req, timeout=HTTP_TIMEOUT_S) as resp:
            resp.read()
            return
    except HTTPError as e:
        body_text = ""
        try:
            body_text = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise IngestError(e.code, body_text) from None
    except URLError as e:
        raise IngestError(0, f"network: {e.reason}") from None


# ─── main loop ────────────────────────────────────────────────────────────

def run_once() -> int:
    cfg = load_config()
    server_url = cfg.get("server_url")
    if not server_url:
        err("config.json missing 'server_url'")
        return 2

    if not AW_DB.exists():
        err(f"AW SQLite not found at {AW_DB} — is ActivityWatch installed and running?")
        return 1

    token = load_token()
    checkpoint = load_checkpoint()

    conn = sqlite3.connect(f"file:{AW_DB}?mode=ro", uri=True)
    try:
        schema = detect_schema(conn)
        buckets = list_buckets(conn, schema)

        total_sent = 0
        for bucket_key, bucket_text_id in buckets:
            source = source_for_bucket(bucket_text_id)
            if source is None:
                continue
            after = checkpoint.get(bucket_text_id, 0)
            rows = fetch_events(conn, schema, bucket_key, after, BATCH_SIZE)
            if not rows:
                continue

            events = [
                build_event(bucket_text_id, source, rid, iso, dur, data)
                for (rid, iso, dur, data) in rows
            ]
            try:
                post_batch(server_url, token, events)
            except IngestError as e:
                # 4xx (except 408, 429) is non-retryable at this layer —
                # don't advance checkpoint, don't keep hammering the server.
                if 400 <= e.status < 500 and e.status not in (408, 429):
                    err(f"{bucket_text_id}: ingest rejected ({e}); "
                        f"keeping checkpoint at row {after}")
                else:
                    err(f"{bucket_text_id}: transient ({e}); "
                        f"keeping checkpoint at row {after}")
                # Bail entire run: if one bucket can't post, others likely
                # can't either, and we want next-run retry semantics.
                return 1

            first_row = rows[0][0]
            last_row = rows[-1][0]
            checkpoint[bucket_text_id] = last_row
            save_checkpoint(checkpoint)
            total_sent += len(events)
            log(f"{bucket_text_id}: sent {len(events)} events (row {first_row}..{last_row})")

        if total_sent == 0:
            log("no new events")
        else:
            log(f"run complete: {total_sent} events across {len(buckets)} buckets")
        return 0
    finally:
        conn.close()


def main() -> int:
    start = time.monotonic()
    rc = run_once()
    log(f"exit={rc} elapsed_s={time.monotonic() - start:.2f}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
