# Mac — Collection Spec (to be implemented)

This is the spec an agent should implement. The phone side is done and working; this is the other half of scrollantir's data story.

## Goal

Get Mac activity flowing into the same ingest endpoint the phone uses, with the same event schema, so the dashboard can reason about both devices uniformly.

## Sources to emit

All events have `device = "mac"`. Source names:

| Source | Type | Data schema | AW origin |
|---|---|---|---|
| `system.window` | duration | `{"app": "Zen", "title": "GitHub — …"}` | `aw-watcher-window` (stock) |
| `system.afk` | duration | `{"status": "afk" \| "not-afk"}` | `aw-watcher-afk` (stock) |
| `zen.tab` | duration | `{"url", "title", "container", "audible", "incognito"}` | `aw-watcher-web` (**forked** to add `container`) |

Matches the event schema defined in `architecture.md`. The ingest server already accepts this payload; the phone uses the same shape.

## What to build

### 1. ActivityWatch installation (documentation only)

The agent doesn't install it, but documents the user step. AW bundle from [activitywatch.net](https://activitywatch.net), installed as a Mac app. Adds `aw-qt` to the menu bar, running `aw-server-rust` + `aw-watcher-window` + `aw-watcher-afk`. AW's local SQLite lands at:

```
~/Library/Application Support/activitywatch/aw-server-rust/sqlite.db
```

The forwarder reads this file read-only. macOS may prompt for Accessibility + Input Monitoring permissions for the watchers on first run.

### 2. Zen Firefox extension setup (the forked `aw-watcher-web`)

Zen is a Firefox-based browser. The agent:

1. **Clones `ActivityWatch/aw-watcher-web`** into `mac-testing/aw-watcher-web/` (or any path — it gets built, not committed).
2. **Adds a `container` field** to each emitted event. In Firefox, tabs belong to a "container" (identified by `cookieStoreId`). Josh uses containers to model his Zen *workspaces* (one container per workspace). Resolving looks like:
   ```javascript
   let containerName = 'no-container';
   if (tab.cookieStoreId && tab.cookieStoreId !== 'firefox-default') {
     try {
       const identity = await browser.contextualIdentities.get(tab.cookieStoreId);
       containerName = identity.name;
     } catch (e) { /* container deleted / incognito */ }
   }
   event.data.container = containerName;
   ```
   Must also add `"contextualIdentities"` and `"cookies"` to `manifest.json`'s `permissions`.
3. **Builds** the Firefox variant (`make build-firefox` or equivalent) and documents how to install the resulting `.xpi` into Zen (`about:debugging` → "Load Temporary Add-on" for dev, or `xpinstall.signatures.required = false` in `about:config` + drag-and-drop for persistent, since Zen allows unsigned extensions).

### 3. Python forwarder

A launchd-scheduled Python script at `mac-forwarder/forwarder.py` that:

- Reads AW's SQLite read-only (`sqlite3.connect(f"file:{AW_DB}?mode=ro", uri=True)`).
- Maintains a per-AW-bucket rowid checkpoint in `~/.scrollantir/checkpoint.json`. On each run: for each known bucket, `SELECT id, timestamp, duration, datastr FROM events WHERE bucket_id = ? AND id > ? ORDER BY id LIMIT 500`.
- Maps AW buckets to scrollantir source strings. AW's bucket names include a hostname suffix — be robust to that:
  ```python
  BUCKET_MAP = {
      "aw-watcher-window":      "system.window",
      "aw-watcher-afk":         "system.afk",
      "aw-watcher-web-firefox": "zen.tab",
  }
  # Match by prefix: if bucket.id.startswith(k) → source = v
  ```
- Synthesizes **deterministic UUIDs** per row: `uuid.uuid5(uuid.NAMESPACE_URL, f"{bucket_id}:{aw_row_id}")`. Ensures retries produce the same ID and the server dedupes cleanly.
- Strips query strings from `zen.tab` URLs before sending (session tokens hide there):
  ```python
  if source == "zen.tab" and "url" in data:
      data["url"] = data["url"].split("?", 1)[0]
  ```
- Batches up to 500 events per POST. Payload per event matches the schema:
  ```json
  {"id": "...", "device": "mac", "source": "system.window",
   "timestamp": "2026-04-20T14:23:01.000Z", "duration_s": 12.3,
   "data": {"app": "Zen", "title": "..."}}
  ```
- On `2xx`: advance checkpoint and persist to `checkpoint.json`.
- On `4xx` (except 408/429): log error to stderr, **do not** advance checkpoint, return — next run retries from same point. Don't block on a bad token.
- On `5xx` / IO error: log, don't advance checkpoint, return. Next run retries.
- Reads bearer token from **macOS Keychain** (`keyring.get_password("scrollantir", "ingest-token")`). Reads server URL from `~/.scrollantir/config.json` (or same keychain entry as a sibling). Never hardcoded.

### 4. launchd agent

Plist at `~/Library/LaunchAgents/com.scrollantir.forwarder.plist`:

- `StartInterval`: 30 (run every 30 seconds — Mac is plugged in most of the time, no battery concern)
- `RunAtLoad`: true (run on login)
- `StandardOutPath` + `StandardErrorPath` → `~/Library/Logs/scrollantir-forwarder.{out,err}.log`
- Loaded with `launchctl load -w ~/Library/LaunchAgents/com.scrollantir.forwarder.plist`

### 5. Setup script

A one-shot shell script (`mac-forwarder/setup.sh`) that:

1. Creates `~/.scrollantir/` if missing
2. Prompts for server URL + token, writes to keychain + config
3. Installs Python deps (venv + `requirements.txt` with `requests`, `keyring`)
4. Copies the plist to `~/Library/LaunchAgents/` with path substitution
5. Loads the launchd agent

## What NOT to do

- Do **not** modify AW's SQLite. Read-only. AW is the owner; we just tap its stream.
- Do **not** use `aw-sync`. It's the documented-rough part of the AW ecosystem. We have our own forwarder.
- Do **not** fork `aw-watcher-window` or `aw-watcher-afk`. Stock works.
- Do **not** commit the vendored `aw-watcher-web` source — `.gitignore` already excludes `vendor/`. Only commit the patched extension as its own directory if the agent decides to version it, clearly marked.
- Do **not** commit the keychain token or the config with the token. Use macOS Keychain.

## Testing the setup

Josh's stub server is at `android-testing/server.py`, listening on `0.0.0.0:8069` with token `dev-token`. After setup, events should start appearing in that server's stdout within a minute, with `device: mac` and the expected source strings. The `.jsonl` log at `android-testing/received/YYYY-MM-DD.jsonl` should also accumulate rows.

Verification checklist:

- Open Zen → switch tabs → terminate forwarder → restart → AW events since last run show up in the stub (checkpoint works)
- Stub server briefly offline → events stay queued in AW, forwarder retries, drains on return
- Open Zen with a URL containing `?utm_source=xxx` → verify query string stripped in server log
- Switch to a container-backed workspace → verify `container` field populates
- Lock screen → system.afk flips to afk → unlock → flips back

## Fit with existing infra

- Ingest endpoint: same `POST /ingest` the phone uses. Same bearer auth.
- Server schema: already handles these events (see `architecture.md`).
- Dashboard: will filter by `device` to slice Mac vs. phone totals.
- `mac-testing/` directory exists (and the stub server lives there). The agent can mirror layout with `mac-forwarder/` for the launchd agent and fork output.

## Commit discipline

Per project convention:

1. **Separate commits for orthogonal work** — ActivityWatch setup notes, extension fork, forwarder, launchd plist/setup each their own commit.
2. **Each commit buildable / testable in isolation.** For example, the forwarder should work even before the extension fork is installed — it'll just not see `container` fields.
3. Commit messages follow the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` convention already established in the repo.

## Reference files the agent must read

Before starting:

- `docs/architecture.md` — event schema, pipeline, idempotency strategy
- `docs/android.md` — how the phone side does the same thing, for pattern consistency
- `docs/setup.md` — current setup documentation, to extend for Mac
- `android-testing/server.py` — to understand exactly what the ingest endpoint expects
- `CREDITS.md` — ActivityWatch attribution belongs here if they add patches
