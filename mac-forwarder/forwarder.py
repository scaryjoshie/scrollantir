"""
Scrollantir Mac forwarder — runtime/ stack edition.

Reads ActivityWatch via its local HTTP API (`aw-client` talks to
aw-server on 127.0.0.1:5600), maps per-bucket events to scrollantir
events, POSTs them one-by-one to the self-hosted PostgREST RPC, and
advances a per-bucket checkpoint.

Run under launchd every 30s. See `com.scrollantir.forwarder.plist`
and `setup.sh`.

Environment:
  SCROLLANTIR_INGEST_URL   base URL of the runtime stack (no path),
                           e.g. https://ingest.178-104-253-30.nip.io
                           or http://localhost for local dev.
                           Required.
  SCROLLANTIR_TOKEN        bearer token (plaintext). Optional; if
                           unset we read from the macOS login keychain
                           under service=`scrollantir-local`,
                           account=`mac` (see setup.sh).
  SCROLLANTIR_CONFIG_DIR   override for ~/.scrollantir (optional).

This forwarder targets the self-hosted runtime/ stack ONLY. The old
Supabase ingest endpoint (`/functions/v1/ingest`, batch
`{events:[...]}`, bearer header) is gone; we POST to PostgREST's
`/rpc/accept_event` one event at a time. The new RPC takes the token
in the JSON body as `p_token` (no Authorization header), the source
prefix is `mac.<existing-source>` (the runtime FK derives device from
source's first segment), and per-event errors don't poison the
batch — we log + continue.

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
  e.g. on DB wipe) plus the scrollantir source name (the unprefixed
  one — keeping the namespacing string stable through the cutover so
  ids hash identically pre/post-cutover for the same AW row).
  The `mac:` literal prefix is about the source-of-id-derivation,
  not the device label; it stays.
- Hold-the-tail discipline: we never ship the newest AW event in a
  bucket — AW heartbeats it until focus changes, so shipping it now
  would freeze duration mid-growth. Once a sibling appears with a
  larger aw_id, the previously-held event is sealed and forwarded.
- Checkpoint is keyed by AW bucket_id. Each entry carries `source`
  and `bucket_created_at` so we can detect bucket rebuilds (same
  bucket_id, new created timestamp → reset id=0) and so the UUID
  input has everything it needs.
- We drain EVERY AW bucket that prefix-matches a known source — not
  just the newest. If hostname drift created a second bucket for the
  same source, both get drained; their events live under different
  `bucket_created_at` → different UUIDs → no collisions on the server.
- Per-event error handling on POST:
    * 28000 (invalid token / source-device mismatch) → permanent;
      log loudly, do NOT advance checkpoint, abort the cycle (no
      point continuing — token's wrong for the whole run).
    * 54000 (rate_limited)                          → transient;
      back off (don't advance checkpoint, abort cycle).
    * P0001 (function-level e.g. negative duration) → permanent for
      this event; log + skip + advance past it.
    * 5xx / network                                 → transient;
      don't advance, abort cycle.
- Single-event POSTs match the new RPC. The N-requests-per-cycle
  cost is fine over LAN for typical Mac workload (30-100 events per
  30s cycle). The 500-event-per-cycle batch limit stays as a
  guardrail against pathological replay floods.
- We rely on aw-server running on localhost:5600. If it's down,
  watchers queue locally (AW's own persist-queue) and drain when it
  comes back. No events are lost.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from aw_client import ActivityWatchClient

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("SCROLLANTIR_CONFIG_DIR", str(HOME / ".scrollantir")))
CHECKPOINT_PATH = CONFIG_DIR / "checkpoint.json"

# Keychain location for the bearer token. Distinct from the legacy
# scrollantir/ingest-token entry so old + new can coexist briefly
# during the transition; the legacy entry is no longer read.
KEYCHAIN_TOKEN_SERVICE = "scrollantir-local"
KEYCHAIN_TOKEN_ACCOUNT = "mac"

BATCH_SIZE = 500       # max events forwarded per cycle (per bucket)
HTTP_TIMEOUT_S = 20

# AW bucket-name prefix → scrollantir source (without the `mac.`
# device prefix). The prefix is added at emit time below; keeping it
# off here lets the existing UUID namespacing string stay stable
# across the cutover so ids hash identically for the same AW row.
BUCKET_PREFIX_TO_SOURCE = [
    ("aw-watcher-window",      "system.window"),
    ("aw-watcher-afk",         "system.afk"),
    ("aw-watcher-web-firefox", "zen.tab"),
]

DEVICE_PREFIX = "mac."


# ─── logging ──────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{ts} {msg}", flush=True)


def err(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{ts} ERROR {msg}", file=sys.stderr, flush=True)


# ─── config + state ───────────────────────────────────────────────────────

def load_ingest_url() -> str:
    url = os.environ.get("SCROLLANTIR_INGEST_URL", "").strip()
    if not url:
        err("SCROLLANTIR_INGEST_URL not set; "
            "expected base URL of the runtime stack "
            "(e.g. https://ingest.178-104-253-30.nip.io)")
        sys.exit(2)
    return url.rstrip("/")


def load_token() -> str:
    """Look for the bearer token in env first, then the macOS login
    keychain under (KEYCHAIN_TOKEN_SERVICE, KEYCHAIN_TOKEN_ACCOUNT).
    No fallback to the legacy scrollantir/ingest-token entry — this
    is the post-cutover path.
    """
    tok = os.environ.get("SCROLLANTIR_TOKEN")
    if tok:
        return tok
    try:
        proc = subprocess.run(
            [
                "security", "find-generic-password",
                "-s", KEYCHAIN_TOKEN_SERVICE,
                "-a", KEYCHAIN_TOKEN_ACCOUNT,
                "-w",
            ],
            check=True, capture_output=True, text=True, timeout=5,
        )
        tok = proc.stdout.strip()
        if tok:
            return tok
    except subprocess.CalledProcessError as e:
        err(f"keychain lookup failed "
            f"({KEYCHAIN_TOKEN_SERVICE}/{KEYCHAIN_TOKEN_ACCOUNT}): "
            f"{(e.stderr or '').strip()}")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        err(f"keychain lookup error: {e}")
    err("no ingest token in env or keychain — run setup.sh")
    sys.exit(2)


# Checkpoint format:
#   { "<aw_bucket_id>": {
#         "source": "<scrollantir source, no `mac.` prefix>",
#         "bucket_created_at": "<ISO-8601 UTC>" | null,
#         "id": <int>,
#         "ts": "<ISO-8601 UTC>"
#       } }
# Legacy format (pre-runtime-cutover): exactly the same shape — we
# just kept the un-prefixed source. The prefix is applied at emit time
# rather than at checkpoint time, so this file's contents survive the
# cutover unchanged.

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


def build_rpc_payload(
    token: str, source: str, bucket_created_iso: str, aw_event,
) -> dict:
    """Build the JSON body posted to /rpc/accept_event.

    The UUID namespacing string keeps the un-prefixed source (the
    pre-cutover form) so deterministic ids match identically for the
    same AW row before and after the runtime migration. The runtime
    payload carries the prefixed source (`mac.<source>`) — that's the
    `events.source` value the new schema enforces via its FK on
    `events.device = split_part(source, '.', 1)`.
    """
    ev_id = str(uuid.uuid5(
        NAMESPACE,
        f"mac:{source}:{bucket_created_iso}:{aw_event.id}",
    ))
    return {
        "p_token":      token,
        "p_id":         ev_id,
        "p_source":     DEVICE_PREFIX + source,
        "p_start_ts":   iso_z(aw_event.timestamp),
        "p_duration_s": round(aw_event.duration.total_seconds(), 3),
        "p_data":       shape_data(source, dict(aw_event.data)),
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

class TransientIngestError(Exception):
    """Cycle should abort and retry next launchd tick (no checkpoint
    advance). 5xx / network / 408 / 429 / pg ERRCODE 54000."""

class FatalAuthIngestError(Exception):
    """Token-level failure. Cycle should abort (no checkpoint advance);
    no point in continuing because the token is wrong for everything.
    Maps pg ERRCODE 28000."""

class PermanentEventError(Exception):
    """Per-event reject (e.g. P0001 from a malformed source). Skip
    this event, advance past it, continue with the next one."""


def post_event(base_url: str, payload: dict) -> None:
    """POST a single event to PostgREST's `/rpc/accept_event`.

    Headers:
      Content-Type: application/json
      Content-Profile: ingest_api  ← routes to ingest_api schema
                                    (PostgREST's default is public)

    No Authorization header — bearer is in the body as `p_token`.
    """
    url = base_url + "/rpc/accept_event"
    req = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Content-Profile": "ingest_api",
            "User-Agent": "scrollantir-mac-forwarder/4-runtime",
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
        # PostgREST returns SQL errors as JSON: {"code":"28000",...}.
        pg_code = ""
        try:
            pg_code = (json.loads(body_text) or {}).get("code", "") or ""
        except (ValueError, AttributeError):
            pass

        msg = f"HTTP {e.code} pg_code={pg_code or '-'}: {body_text[:200]}"

        # Map pg error class first (richer than HTTP status alone).
        if pg_code == "28000":
            raise FatalAuthIngestError(msg) from None
        if pg_code == "54000":
            raise TransientIngestError(msg) from None
        if pg_code == "P0001":
            raise PermanentEventError(msg) from None
        # Fallbacks by HTTP status.
        if e.code in (408, 429) or 500 <= e.code < 600:
            raise TransientIngestError(msg) from None
        if 400 <= e.code < 500:
            # Some other 4xx without a recognized pg code (e.g.
            # PostgREST routing error). Treat as per-event permanent
            # so a single bad event doesn't wedge the queue.
            raise PermanentEventError(msg) from None
        raise TransientIngestError(msg) from None
    except URLError as e:
        raise TransientIngestError(f"network: {e.reason}") from None


# ─── main loop ────────────────────────────────────────────────────────────

EPOCH_ISO = "1970-01-01T00:00:00Z"


def drain_bucket(
    aw: ActivityWatchClient,
    bucket_id: str,
    source: str,
    bucket_created_iso: str,
    cp: dict | None,
    base_url: str,
    token: str,
) -> tuple[int, dict | None]:
    """Fetch new events for one bucket, POST one-at-a-time, return
    (events_sent, new_checkpoint_entry_or_None).

    Forwards only *sealed* events: the newest event per bucket is
    held back every run because AW heartbeats it until focus changes,
    and shipping it mid-growth would freeze its duration at a snapshot
    (this bug dropped ~93% of mac activity before catch; see
    docs/sessions/session-2026-04-23-aw-forwarder.md). Once a
    newer-id sibling appears, the previously-held event is sealed at
    its final duration and gets forwarded on the next drain.

    Per-event PermanentEventError (e.g. malformed source rejected by
    the regex CHECK) is logged and skipped — we still advance past it
    so the queue drains. FatalAuthIngestError + TransientIngestError
    abort the cycle (raised to caller).
    """
    # Detect bucket rebuild (same aw_bucket_id but AW recreated the
    # bucket — e.g., DB wipe). Under the UUID scheme the rebuilt
    # bucket's events hash into a distinct generation, so resetting
    # id=0 is safe: fresh aw_ids won't collide with old on the server.
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

    # Cap forwarded count per cycle to BATCH_SIZE — guardrail against
    # pathological replay floods. The remaining events are picked up
    # next cycle.
    if len(to_forward) > BATCH_SIZE:
        log(
            f"{bucket_id}: capping {len(to_forward)} events to "
            f"{BATCH_SIZE} this cycle; rest next run"
        )
        to_forward = to_forward[:BATCH_SIZE]

    sent = 0
    last_sent_ev = None  # the AW event corresponding to the last successful POST
    for aw_ev in to_forward:
        payload = build_rpc_payload(token, source, bucket_created_iso, aw_ev)
        try:
            post_event(base_url, payload)
        except PermanentEventError as e:
            # Bad event — skip it but advance past it on the
            # checkpoint. This matches the existing
            # "advance-past-survivors" semantics: one malformed
            # event shouldn't poison the queue.
            err(
                f"{bucket_id}: skipping aw_id={aw_ev.id} "
                f"({source}): {e}"
            )
            last_sent_ev = aw_ev
            continue
        sent += 1
        last_sent_ev = aw_ev

    # If nothing made it through (every event was a permanent reject)
    # and there's still a held tail, advance to the last skipped id so
    # we don't re-attempt the rejects forever. last_sent_ev is set in
    # both the success and PermanentEventError branches, so it's
    # always the last id we processed.
    advanced_id = last_sent_ev.id if last_sent_ev is not None else cp["id"]
    advanced_id = min(advanced_id, tail.id - 1)
    # Timestamp guard against backward-stepping cascades — same logic
    # as before-cutover.
    forwarded_ts_candidates = [tail.timestamp]
    if last_sent_ev is not None:
        forwarded_ts_candidates.append(last_sent_ev.timestamp)
    new_cp = {
        "source": source,
        "bucket_created_at": bucket_created_iso,
        "id": advanced_id,
        "ts": iso_z(min(forwarded_ts_candidates)),
    }
    return sent, new_cp


def run_once() -> int:
    base_url = load_ingest_url()
    token = load_token()
    checkpoint = load_checkpoint()

    aw_host = os.environ.get("SCROLLANTIR_AW_HOST", "127.0.0.1")
    aw_port = int(os.environ.get("SCROLLANTIR_AW_PORT", "5600"))

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
                aw, bucket_id, source, bucket_created_iso, cp,
                base_url, token,
            )
        except FatalAuthIngestError as e:
            err(f"{bucket_id}: AUTH FAIL ({e}); checkpoint unchanged. "
                "fix the token (setup.sh) before next cycle.")
            return 1
        except TransientIngestError as e:
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
