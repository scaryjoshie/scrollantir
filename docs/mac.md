# Mac — Collection Spec

Uses ActivityWatch as the watcher layer. We do not use `aw-sync` or `aw-webui`. A custom forwarder drains AW's local SQLite to the server.

## Sources emitted

All events have `device = "mac"`. Source naming follows [architecture.md](architecture.md): `{namespace}.{specifier}`.

| Source | Type | Data schema | Component |
|---|---|---|---|
| `system.window` | duration | `{"app": "...", "title": "..."}` | aw-watcher-window (stock) |
| `system.afk` | duration | `{"status": "afk" \| "not-afk"}` | aw-watcher-afk (stock) |
| `zen.tab` | duration | `{"url", "title", "container", "audible", "incognito"}` | **aw-watcher-web, forked to add `container`** |

## ActivityWatch setup

1. Install the AW bundle from activitywatch.net — this gives you `aw-qt` in the menu bar, which supervises `aw-server-rust`, `aw-watcher-window`, `aw-watcher-afk`.
2. Grant macOS permissions on first run (System Settings → Privacy & Security):
   - **Accessibility** → aw-watcher-window (window titles)
   - **Input Monitoring** → aw-watcher-afk (idle detection)
3. Install the ActivityWatch Firefox extension from addons.mozilla.org inside Zen. It auto-discovers `aw-server` on `localhost:5600` and creates `aw-watcher-web-firefox_<hostname>` bucket.
4. Verify: visit `http://localhost:5600`, check for recent events in all three buckets.

Local AW DB path: `~/Library/Application Support/activitywatch/aw-server-rust/sqlite.db`.

## Zen workspaces via Firefox Containers

Chosen over a Zen Mod approach: containers are stable WebExtension API, not Zen internals that can shift between versions.

1. Zen Settings → General → Container Tabs → create one container per workspace (Work, Personal, etc.). Distinct colors/icons.
2. Right-click each workspace in the Zen sidebar → Set Profile → assign matching container as the workspace's default.
3. Install forked `aw-watcher-web` (below).

Workspace labeling is a convention, not ground truth — a tab opened in the "wrong" container will be mis-labeled. Acceptable trade for avoiding userChrome hackery.

## Forked `aw-watcher-web`

Clone `ActivityWatch/aw-watcher-web`. In the background script where the event payload is assembled from a `tabs.onActivated` / `tabs.onUpdated` event, resolve the cookieStoreId:

```javascript
let containerName = 'no-container';
if (tab.cookieStoreId && tab.cookieStoreId !== 'firefox-default') {
  try {
    const identity = await browser.contextualIdentities.get(tab.cookieStoreId);
    containerName = identity.name;
  } catch (e) {
    // container deleted, private browsing, etc.
  }
}
event.data.container = containerName;
```

Add to `manifest.json` permissions array:

```json
"permissions": ["tabs", "storage", "contextualIdentities", "cookies", "<all_urls>"]
```

Build: `make build-firefox`. Result: a signed or unsigned `.zip` in `dist/`.

Install options:
- **Temporary** (unsigned): `about:debugging` → This Firefox → Load Temporary Add-on. Unloads on restart.
- **Persistent, recommended**: Set `xpinstall.signatures.required = false` in `about:config`. Zen allows this (standard Firefox on release doesn't). Then install the built `.xpi`.
- Alternative: sign through own AMO developer account (free, small effort).

## Idle detection and "was Zen really focused"

`aw-watcher-web` fires on tab events *even if Zen isn't focused*. For accurate time, join at query time:

```
zen.tab events ∩ (system.window where app = "zen") ∩ (system.afk where status = "not-afk")
```

This happens in the dashboard layer, not the collection layer.

## Mac forwarder

Small Python daemon, launched via launchd agent. Polls AW's SQLite, batches, POSTs to server, tracks a checkpoint per bucket.

Why a checkpoint on Mac (not on Android)?
- Android owns its own queue; we delete on ack.
- On Mac, AW owns the SQLite and we don't want to mutate it. Instead, we read events with `id > last_forwarded_id` per bucket.

Sketch:

```python
import requests, sqlite3, json, pathlib, time, uuid
from datetime import datetime, timezone

AW_DB = pathlib.Path.home() / "Library/Application Support/activitywatch/aw-server-rust/sqlite.db"
CHECKPOINT = pathlib.Path.home() / ".scrollantir/checkpoint.json"
SERVER = "https://scrollantir.example.com/ingest"
TOKEN = keyring.get_password("scrollantir", "ingest-token")

# Maps an AW bucket to the scrollantir source string we emit under device="mac"
BUCKET_TO_SOURCE = {
    "aw-watcher-window_<host>":      "system.window",
    "aw-watcher-afk_<host>":         "system.afk",
    "aw-watcher-web-firefox_<host>": "zen.tab",
}

def load_checkpoint():
    if CHECKPOINT.exists():
        return json.loads(CHECKPOINT.read_text())
    return {}

def save_checkpoint(cp):
    CHECKPOINT.parent.mkdir(parents=True, exist_ok=True)
    CHECKPOINT.write_text(json.dumps(cp))

def poll_and_forward():
    cp = load_checkpoint()
    conn = sqlite3.connect(f"file:{AW_DB}?mode=ro", uri=True)
    batch = []
    new_cp = dict(cp)
    for bucket_id, source in BUCKET_TO_SOURCE.items():
        last_id = cp.get(bucket_id, 0)
        rows = conn.execute(
            "SELECT id, timestamp, duration, datastr FROM events "
            "WHERE bucket_id = ? AND id > ? ORDER BY id LIMIT 500",
            (resolve_bucket_rowid(bucket_id), last_id)
        ).fetchall()
        for id_, ts, dur, datastr in rows:
            batch.append({
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{bucket_id}:{id_}")),
                "device": "mac",
                "source": source,
                "timestamp": ts,          # AW stores ISO-8601 UTC already
                "duration_s": dur,
                "data": json.loads(datastr),
            })
            new_cp[bucket_id] = id_

    if not batch:
        return

    # Strip query strings client-side for zen.tab (session tokens hide there)
    for e in batch:
        if e["source"] == "zen.tab" and "url" in e["data"]:
            e["data"]["url"] = e["data"]["url"].split("?", 1)[0]

    r = requests.post(
        SERVER,
        headers={"Authorization": f"Bearer {TOKEN}"},
        json=batch,
        timeout=30,
    )
    if r.status_code == 200:
        save_checkpoint(new_cp)
```

Note on IDs: AW uses auto-increment integer IDs. We synthesize a deterministic UUID via `uuid5(NAMESPACE_URL, f"{bucket}:{id}")` so retries of the same row produce the same UUID, giving us the server-side `ON CONFLICT DO NOTHING` idempotency without tracking per-row ack state.

### launchd agent

`~/Library/LaunchAgents/com.scrollantir.forwarder.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.scrollantir.forwarder</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>python3</string>
        <string>/Users/joshua/dev/scrollantir/mac-forwarder/forwarder.py</string>
    </array>
    <key>StartInterval</key>
    <integer>30</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/joshua/Library/Logs/scrollantir-forwarder.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/joshua/Library/Logs/scrollantir-forwarder.err.log</string>
</dict>
</plist>
```

Load: `launchctl load ~/Library/LaunchAgents/com.scrollantir.forwarder.plist`.

Cadence: 30s. Low enough for "feels live," far below what would strain anything.

## Secrets handling

Ingest token stored in macOS Keychain:

```bash
security add-generic-password -s scrollantir -a ingest-token -w
# enter the bearer token at the prompt
```

Read from Python via the `keyring` package (uses Keychain on Mac):

```python
import keyring
token = keyring.get_password("scrollantir", "ingest-token")
```

Never put the token in the launchd plist, in the forwarder source, or in a config file committed to git.

## Build order

1. **Install AW + Firefox extension**, verify events in `localhost:5600`. Confirms collection is working baseline.
2. **Set up containers in Zen** for each workspace, one-to-one with your mental workspace model.
3. **Fork aw-watcher-web**, add container field, install via temporary load, verify `data.container` appears in web bucket events.
4. **Make the fork permanent** via `xpinstall.signatures.required = false` or self-signing.
5. **Mac forwarder against stub server** (same ngrok + FastAPI from Android Stage 3). Verify checkpoint advances, no duplicates on restart.
6. **Launchd agent** so it runs on login.
7. **Point at real server** once Android is also flowing data.

## Risks / open issues

- Zen specifically: the Firefox extension installed inside Zen may interact with Zen's own tab isolation features in unexpected ways. Needs smoke testing.
- The `xpinstall.signatures.required` workaround is Zen-permitted but non-standard Firefox behavior. Alternative signing path is safer long-term.
- AW's aw-watcher-web has open issue #1124 noting that the system-level watcher can't read Firefox URLs on Mac — which is exactly why we need the extension. Stays true for Zen.
- If Zen updates change how workspace → container assignment works, re-verify container labeling.
