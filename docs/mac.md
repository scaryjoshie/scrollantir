# Mac collection — implementation reference

Mac activity flows into Supabase via the same ingest endpoint and event
schema as the phone. Three sources today: `system.window`, `system.afk`,
`zen.tab`. ActivityWatch owns the local SQLite buffer; a Python launchd
forwarder reads it on a 30 s interval and POSTs batches to
`/functions/v1/ingest`.

## Status

✅ Live since 2026-04-21. Hold-the-tail correctness fix landed
2026-04-25 (`session-2026-04-23-aw-forwarder.md`); event durations
now reflect AW's final sealed values rather than mid-heartbeat
snapshots.

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

## Verifying the setup

After running `mac-forwarder/setup.sh` and pasting the Supabase ingest URL +
device bearer token, expect a log line every 30 s in
`~/Library/Logs/scrollantir-forwarder.out.log`. Events land in
`public.events` within roughly the same window.

Verification checklist:

- Open Zen → switch tabs → terminate forwarder → restart → AW events since
  last run show up in Supabase (checkpoint works)
- Forwarder briefly offline → events stay queued in AW, forwarder retries,
  drains on return without duplicates (UUID5 keyed deterministically)
- Open Zen with a URL containing `?utm_source=xxx` → query string stripped
  before POST
- Switch to a container-backed workspace → `data.container` populates with
  the workspace name
- Lock screen → `system.afk` flips to `status="afk"` → unlock → flips back

## Fit with existing infra

- Ingest endpoint: same `POST /functions/v1/ingest` the phone uses. Same
  bearer auth, same event schema.
- Server schema: see `architecture.md` and `data-model.md`.
- Dashboard: filters by `device` to slice Mac vs. phone totals; consumes
  `system.window` + `zen.tab` for the Mac timeline lane.

## Commit discipline

Per project convention:

1. **Separate commits for orthogonal work** — ActivityWatch setup notes, extension fork, forwarder, launchd plist/setup each their own commit.
2. **Each commit buildable / testable in isolation.** For example, the forwarder should work even before the extension fork is installed — it'll just not see `container` fields.
3. Commit messages follow the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` convention already established in the repo.

## Reference files

- `docs/architecture.md` — event schema, pipeline, idempotency strategy
- `docs/data-model.md` — primitives catalog (mac sources catalogued here)
- `docs/android.md` — how the phone side does the same thing
- `docs/setup.md` — install runbook
- `docs/session-2026-04-23-aw-forwarder.md` — the truncation bug + fix
- `CREDITS.md` — ActivityWatch attribution
