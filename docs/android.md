# Android — Implementation Reference

Documents what's actually built in `/android/`. Target device: Google Pixel 9 (Android 14+). Sideload only, no Play Store.

## Sources emitted

All events have `device = "phone"`. Stored via `app.scrollantir.db.emit()` into Room.

| Source | Type | Data schema | Producer |
|---|---|---|---|
| `system.foreground` | duration | `{"app": "<package>"}` | `UsageStatsPoller` |
| `system.screen` | duration | `{"state": "on"}` | `ScreenWatcher` (BroadcastReceiver) |
| `system.unlocked` | duration | `{}` | `ScreenWatcher` (USER_PRESENT→SCREEN_OFF pair) |
| `system.unlock` | point | `{}` | `ScreenWatcher` (USER_PRESENT) |
| `youtube.shorts` | duration | `{}` | `ContentDetectorService` |
| `instagram.reels` | duration | `{}` | `ContentDetectorService` |
| `instagram.stories` | duration | `{}` | `ContentDetectorService` |
| `tiktok.feed` | duration | `{}` | `ContentDetectorService` |
| `detector.miss` | point | `{"package", "view_ids"}` | `ContentDetectorService` (throttled 60s/pkg) |

ReVanced YouTube (`app.revanced.android.youtube`) emits under the same `youtube.shorts` source as stock YouTube — downstream queries don't have to distinguish.

## App architecture

```
MainActivity (Compose)
├─ TodayScreen ← shown by default
│    ├─ Status pill (pulsing green dot = tracking live)
│    ├─ "Phone time" / "Unlocks" summary tiles
│    ├─ CurrentSessionTile (live in-flight foreground app, 1s tick)
│    ├─ Short-form card (youtube.shorts, instagram.reels, tiktok.feed)
│    └─ Apps card (per-pkg foreground totals, day-clipped, with icons + bars)
│
└─ SettingsScreen ← opened via ⚙ icon
     ├─ Tracking control (start / pause)
     ├─ Permissions cards (Notifications, Usage, Battery, Accessibility)
     ├─ Sync card (last-sync status + "Sync now")
     ├─ Server settings (URL + bearer token, EncryptedSharedPreferences)
     └─ Version footer (v{VERSION_NAME} · built {BUILD_TIME_MS})

TrackerForegroundService (FOREGROUND_SERVICE_TYPE_DATA_SYNC)
├─ UsageStatsPoller (Coroutine, every 2.5s)
│    ├─ queryEvents(lastQuery, now) → ACTIVITY_RESUMED transitions
│    ├─ emits system.foreground
│    ├─ updates currentForeground StateFlow (→ TodayScreen Now tile)
│    └─ on leaving a detector-target pkg, calls
│       ContentDetectorService.notifyForegroundLeft()
│
├─ ScreenWatcher (BroadcastReceiver, runtime-registered)
│    ├─ ACTION_SCREEN_ON / _OFF → system.screen
│    ├─ ACTION_USER_PRESENT → system.unlock (point)
│    └─ USER_PRESENT + SCREEN_OFF pairs → system.unlocked
│
└─ onDestroy: runBlocking(NonCancellable) { poller.flushCurrent(now) }
    before scope.cancel() — final foreground session lands in DB.

ContentDetectorService (AccessibilityService)
├─ Receives events from every app (no packageNames filter — see below)
├─ In-code filter: rulesByPackage[pkg] ?: return
├─ 500ms throttle, then tree-walk for matching primaryViewId + requiresPresent
├─ State machine: current mode, emit on transition, MAX_MISSES_BEFORE_CLOSE=3
└─ Closes current session on onForegroundLeftTarget() call from poller

ForwarderWorker (CoroutineWorker, periodic 15min)
├─ Reads SecurePrefs for serverUrl + token
├─ SELECT * WHERE forwarded_at IS NULL LIMIT 500
├─ POST batch via OkHttp with Authorization: Bearer <token>
├─ 2xx → UPDATE events SET forwarded_at = now WHERE id IN (:ids)
├─ 4xx except 408/429 → Result.success() without marking (preserves queue,
│   no retry storm on bad token)
├─ 5xx / 408 / 429 / IOException → Result.retry() with exponential backoff
└─ Updates ForwarderWorker.status StateFlow + SecurePrefs KEY_LAST_SYNC_*

CleanupWorker (CoroutineWorker, periodic 6h)
└─ DELETE WHERE forwarded_at IS NOT NULL AND forwarded_at < now - 48h
```

## Android 15 install workaround (critical)

Android 15's Enhanced Confirmation Mode blocks accessibility-service event delivery for apps installed via plain `adb install` / Android Studio's green Run button. Symptoms: service binds, `onServiceConnected` fires, but `onAccessibilityEvent` is never called.

The workaround is to set the installer-source metadata to Play Store's package name, `com.android.vending`. Two layers of this in the build:

1. **`installation` block in `app/build.gradle.kts`** applies to Android Studio's Run button. AGP 9 passes our `installOptions` to `adb install`:
   ```kotlin
   android.installation {
       installOptions.addAll(listOf("-r", "-i", "com.android.vending"))
   }
   ```
2. **Custom `installDebugSpoofed` Gradle task** for CLI use:
   ```bash
   ./gradlew :app:installDebugSpoofed
   ```

APK bytes, signing, and runtime behavior are all identical to a normal debug install. Only the `PackageManager.getInstallSourceInfo().getInstallingPackageName()` metadata changes — from `com.google.android.packageinstaller` (flagged as sideloaded) to `com.android.vending` (flagged as Play Store).

**Every reinstall requires the spoof.** APK updates also reset accessibility toggles — expect to re-enable accessibility in Settings after each install.

## AccessibilityService configuration

Two bugs we hit and fixed during Stage 4 debugging, documented so they don't regress:

### Manifest meta-data key (was wrong)

Must be `android.accessibilityservice`, *not* the fully-qualified class name. Using the wrong key made Android silently not load the XML config at all — the service would bind but have no event contract.

```xml
<service
    android:name=".tracker.ContentDetectorService"
    android:exported="true"
    android:label="@string/app_name"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
    <intent-filter>
        <action android:name="android.accessibilityservice.AccessibilityService" />
    </intent-filter>
    <meta-data
        android:name="android.accessibilityservice"
        android:resource="@xml/content_detector_config" />
</service>
```

### `content_detector_config.xml`

```xml
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeAllMask"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagReportViewIds|flagIncludeNotImportantViews"
    android:canRetrieveWindowContent="true"
    android:description="@string/content_detector_description"
    android:notificationTimeout="100" />
```

No `packageNames` filter. We tried adding it for battery (would cut wakeups ~95%) but on this device it silently broke detection — we listen to all apps and filter in code. One `HashMap` lookup + early return for non-target packages in the hot path. Acceptable cost.

`flagReportViewIds` is required — without it, `findAccessibilityNodeInfosByViewId` returns nothing even with a valid view tree.

## Detection rules (from DigiPaws)

Detection patterns ported from DigiPaws' `ReelAppConfig.kt` (GPL-3.0, credited in `/CREDITS.md`). Each rule is `{source, primaryViewId, requiresPresent, eventTypeMask}` — the primary viewId must be found, and every requiresPresent id must also be present, before emitting.

| Source | primaryViewId | requiresPresent | Event types |
|---|---|---|---|
| `youtube.shorts` (stock) | `com.google.android.youtube:id/reel_recycler` | — | STATE_CHANGED + CONTENT_CHANGED |
| `youtube.shorts` (ReVanced) | `app.revanced.android.youtube:id/reel_recycler` | — | STATE_CHANGED + CONTENT_CHANGED |
| `instagram.reels` | `com.instagram.android:id/clips_viewer_view_pager` | `clips_ufi_component` | VIEW_SCROLLED + CONTENT_CHANGED + STATE_CHANGED |
| `instagram.stories` | `com.instagram.android:id/reel_viewer_root` | — | (same as reels) |
| `tiktok.feed` | `*` (sentinel — any event from pkg counts) | — | TYPES_ALL_MASK |

Resource IDs drift between app versions. When a target app is foregrounded but no rule matches, `ContentDetectorService` emits `detector.miss` (throttled to at most one per package per 60 seconds) with up to 20 view IDs seen in the tree. Use this to update rules when YouTube/IG redesigns.

## Permissions

| # | Permission | Purpose | Intent |
|---|---|---|---|
| 1 | `POST_NOTIFICATIONS` (A13+) | Foreground service notification | Runtime prompt |
| 2 | `PACKAGE_USAGE_STATS` | Reading foreground app transitions | `ACTION_USAGE_ACCESS_SETTINGS` |
| 3 | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Service survival | `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` |
| 4 | Accessibility Service toggle | Content-mode detection | `ACTION_ACCESSIBILITY_SETTINGS` |

SettingsScreen renders a status row per permission. `DisposableEffect` observer re-checks on `ON_RESUME` so returning from Settings auto-updates the dots.

Tracking is gated only on #1 and #2. #3 is recommended but not required. #4 is optional — tracking works without it, just without Shorts/Reels distinction.

## Forwarder + cleanup workflow

Events live in Room with nullable `forwarded_at`. Timeline of a single event:

```
[T]      emit() inserts row, forwarded_at=NULL
         ↓ (up to 15 min later)
[T+Δ1]   ForwarderWorker picks it up in a batch of ≤500
         ↓
[T+Δ1']  Server returns 2xx → UPDATE forwarded_at = now
         ↓ (up to 48h later)
[T+48h]  CleanupWorker deletes the row
```

On 4xx, step 3 is skipped and the row stays pending. The user will see a red-tinted error in the Sync card; next periodic run retries from scratch but backs off cleanly.

On device offline, step 2 fails with IOException → `Result.retry()`, batch stays unsent, queue grows. When network returns, drains normally.

### Why 48h retention

The TodayScreen aggregates per-app totals from the local Room DB, not the server. This lets the dashboard work even when the server is unreachable all day. 48h gives a buffer: if the forwarder's been down for a day, today's dashboard still reflects reality. After 48h, the server is the source of truth for historical queries.

## Today screen aggregation

Avoids server round-trips and naive SQL by doing the aggregation in Kotlin:

1. DAO: `foregroundEventsSince(lookbackIso)` returns raw rows from 24h before today-start. This ensures sessions spanning midnight are captured.
2. Kotlin post-process (`aggregateAppsClipped`): for each event, compute `effective = min(end, now) - max(start, todayStart)`, group by package, sum, filter via `EventFilter.isSignalApp(pkg)` (hides systemui, inputmethod, etc.) and `>= MIN_FOREGROUND_S (=2.0)`.
3. Folds in the live `UsageStatsPoller.currentForeground` StateFlow so an in-flight YouTube session that started 20 minutes ago and hasn't been emitted to DB yet is still visible.
4. Bars render proportional to `max(totals)`. Icons + labels via `AppIconCache.rememberAppInfo(pkg)`.

Mode aggregation uses the same pattern with `contentModeEventsSince`.

## Persistent tracking preference

`SecurePrefs.KEY_TRACKING_ENABLED` stores whether the user has tracking on. Written by `TrackerForegroundService.start/stop`. `BootReceiver` reads it on `ACTION_BOOT_COMPLETED` — only resumes tracking if the user had it on before the reboot. A user who deliberately paused tracking won't have it silently come back.

## Known tradeoffs

1. **No packageNames filter** — accessibility service processes ~95% more events than it needs to. Battery tax is real but small; in-code filter is constant-time. We tried adding the filter back; detection regressed on this device. Live with it.
2. **No poller state persistence** — OOM kill of our process loses the in-flight foreground session state. At most one session lost per crash. Architecture doc acknowledges this.
3. **IngestClient recreated per WorkManager run** — creating a fresh `OkHttpClient` every 15 minutes is wasteful but not meaningful at this volume.
4. **AppIconCache unsynchronized** — HashMap accessed from main thread (read) + Dispatchers.IO (write). Benign race, no crashes observed; would switch to `ConcurrentHashMap` if we saw issues.
5. **`usesCleartextTraffic="true"`** — required for LAN-IP dev server. Before shipping to a public HTTPS server, replace with a `network_security_config.xml` that locks cleartext to RFC1918 (192.168/10/172.16-31).

## Build / toolchain

| Tool | Version | Notes |
|---|---|---|
| Android Gradle Plugin | 9.1.1 | AGP 9's `installation.installOptions` is what makes the spoof work for Studio Run |
| Kotlin | 2.2.10 | |
| KSP | 2.2.10-2.0.2 | For Room codegen |
| Compose BOM | 2026.02.01 | |
| Room | 2.7.1 | `fallbackToDestructiveMigration(dropAllTables = true)` — no migration code, we just wipe on schema change |
| WorkManager | 2.10.0 | |
| OkHttp | 4.12.0 | |
| Security Crypto | 1.1.0-alpha06 | EncryptedSharedPreferences |
| kotlinx.coroutines | 1.9.0 | |
| min SDK | 24 | |
| target SDK | 36 | Minor API level 1 |

## Running / setup

See `docs/setup.md` for install, stub-server, and permission-grant steps.
