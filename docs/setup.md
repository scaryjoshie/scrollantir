# Setup notes

## Android — install with Play Store installer spoof (Android 15+)

Android 15's Enhanced Confirmation Mode blocks accessibility-service event
delivery for apps installed via plain `adb install` / Android Studio's Run
button. Symptom: service binds, `onServiceConnected` fires, but
`onAccessibilityEvent` is never called.

Workaround: install with `-i com.android.vending` so Android records the
installer as Play Store and lets the service run.

### Easiest path: the Gradle task

```bash
cd ~/dev/scrollantir/android
./gradlew :app:installDebugSpoofed
```

That task runs `assembleDebug` then `adb install -r -i com.android.vending`
with the resulting APK. After every rebuild, run this instead of Android
Studio's green Run button.

### Manual equivalent

```bash
./gradlew :app:assembleDebug
~/Library/Android/sdk/platform-tools/adb install -r -i com.android.vending \
  app/build/outputs/apk/debug/app-debug.apk
```

### What still breaks accessibility even with the spoof

- **Fully uninstalling the app** resets the installer-source, so after an
  `adb uninstall`, the next install should also use `-i com.android.vending`.
- **Rebooting the phone** does not break anything; accessibility stays
  enabled across reboots.
- **OTA updates** have been known to silently disable accessibility
  services on Pixel; re-enable in Settings → Accessibility if you stop
  seeing `youtube.shorts` events after a system update.

## Supabase backend

One-time. Before any forwarder posts real data.

```bash
brew install supabase/tap/supabase
cd ~/dev/scrollantir
supabase login                  # opens browser (run in your own terminal, not this shell)
supabase link --project-ref <your-project-ref>   # e.g. feijpewzqgqczkxmvdng for the maintainer's instance
```

Then whenever schema changes:

```bash
supabase db diff -f <migration_name> --schema public,private,ingest_api,agent_api
# review the generated file in supabase/migrations/
# manually append any schema USAGE / function EXECUTE grants + ALTER VIEW
#   (the declarative diff tool doesn't capture these)
supabase db push --include-roles --include-seed
```

For schema design details, trust boundaries, and RPC signatures, see
[`supabase.md`](supabase/README.md). For admin tooling (device add, token
mint, role password setup), see [`admin-cli.md`](supabase/admin-cli.md). For
edge function deployment, see [`edge-functions.md`](supabase/edge-functions.md).

## Mac collector

Spec in [mac.md](mac/README.md). Code lives in:

- `mac-forwarder/` — the Python launchd forwarder + setup script
- `mac-extension/` — the patched `aw-watcher-web` that tags tab events
  with the Firefox container name (we use one container per Zen
  workspace, so container ≈ workspace)

### 1. Install ActivityWatch

Download from [activitywatch.net](https://activitywatch.net) and
install to `/Applications`. Launching it puts `aw-qt` in the menu bar
and starts `aw-server-rust` + `aw-watcher-window` + `aw-watcher-afk`
automatically. On first run macOS will prompt for Accessibility and
Input Monitoring permissions for the watchers — grant them.

AW's local SQLite lands at:

```
~/Library/Application Support/activitywatch/aw-server-rust/sqlite.db
```

The forwarder reads this file read-only.

### 2. Build and install the Zen extension

```bash
cd ~/dev/scrollantir/mac-extension
./build.sh
```

That clones the upstream `aw-watcher-web` at a pinned commit, applies
`zen-container.patch`, runs the Firefox vite build, and produces
`artifacts/aw-watcher-web-zen.xpi`. A pre-built xpi is also checked in
so you don't need Node/npm unless you're editing the patch.

Install the xpi into Zen:

- **Persistent:** `about:config` → set
  `xpinstall.signatures.required` to `false`, then drag
  `artifacts/aw-watcher-web-zen.xpi` onto a Zen window and confirm
  the install.
- **Temporary (dev):** `about:debugging#/runtime/this-firefox` → *Load
  Temporary Add-on…* → pick the xpi. Cleared on restart.

Open the extension's options page and point it at `http://127.0.0.1:5600`
(the local aw-server-rust). You should see an `aw-watcher-web-firefox_<hostname>`
bucket appear in AW shortly after browsing.

### 3. Run the forwarder setup script

```bash
cd ~/dev/scrollantir/mac-forwarder
./setup.sh
```

It prompts for the ingest server URL and bearer token, stores the
token in the macOS login keychain under service `scrollantir` /
account `ingest-token`, writes the URL to `~/.scrollantir/config.json`,
builds a venv at `mac-forwarder/.venv/`, installs `keyring`, renders
the launchd plist, and loads the agent. Safe to re-run to change
server URL or token.

Verify it's running:

```bash
launchctl list | grep scrollantir
tail -f ~/Library/Logs/scrollantir-forwarder.out.log
```

Expect a log line every 30 seconds. The first run against a fresh AW
install will send a batch of backfill from the moment AW started.

### 4. Point at Supabase

After `scripts/admin.py setup-roles` and `admin mint --device-id mac
--show-token` (see `docs/admin-cli.md`), run `mac-forwarder/setup.sh`
and paste:
- URL: `https://<project-ref>.supabase.co/functions/v1/ingest`
- Token: the plaintext from `mint`

### Verification checklist

Inspect a few rows directly in Supabase (or via `psql` as
`agent_role`) after running for a couple of minutes:

- **Window events:** switch between apps on the Mac → within 30s,
  `system.window` rows with `app` + `title` should appear.
- **AFK events:** lock the screen for >4 minutes (AW's afk threshold),
  unlock → `system.afk` rows flipping `status` between `not-afk` and
  `afk`.
- **Zen tabs:** visit tabs in a container-backed workspace →
  `zen.tab` rows with `container` populated with the workspace name.
- **URL sanitation:** visit any URL with `?utm_source=...` → the row's
  `data.url` has the query string stripped.
- **Crash recovery:** `launchctl unload` the agent mid-run →
  `launchctl load -w` it again → no duplicate events because event
  IDs are derived from `uuid5(NAMESPACE_URL, "mac:{source}:{bucket_created_at}:{aw_id}")`.
- **Server offline:** simulate by killing the network briefly →
  forwarder logs the failure, keeps the checkpoint untouched, AW's DB
  untouched → next run drains cleanly.

### Troubleshooting

- **No buckets detected.** The forwarder only considers buckets whose
  `id` starts with `aw-watcher-window`, `aw-watcher-afk`, or
  `aw-watcher-web-firefox`. If AW's running but no events are
  forwarded, check bucket IDs via the AW web UI at
  `http://127.0.0.1:5600`.
- **Bad token.** The forwarder logs `ingest rejected (HTTP 401…)` and
  does not advance the checkpoint. Re-run `mac-forwarder/setup.sh` to
  update the keychain entry.
- **Rotating the token.** `security delete-generic-password -s
  scrollantir -a ingest-token` then re-run setup.sh (or just re-run
  setup.sh — it overwrites).

