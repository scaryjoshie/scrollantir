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
cd /Users/joshua/dev/scrollantir/android
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

## Mac collector

Not yet built. Spec is in [mac.md](mac.md) — ActivityWatch + a forked
`aw-watcher-web` (adds Zen container tracking) + a Python launchd
forwarder that reads AW's SQLite and POSTs to the same ingest
endpoint the phone uses.

## Starting the stub server (current dev ingest)

```bash
cd /Users/joshua/dev/scrollantir/android-testing
uv run --with fastapi --with uvicorn --with pydantic python server.py
```

Listens on `0.0.0.0:8069`, bearer token `dev-token`. Find your Mac's LAN IP
with `ipconfig getifaddr en0` and enter `http://<that-ip>:8069` + `dev-token`
in the app's Settings → Server section.
