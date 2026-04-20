# Android — Implementation Reference

Documents what's actually built in `/android/`. Target device: Google Pixel 9 (Android 14+). Sideload only, no Play Store.

## Sources emitted

All events have `device = "phone"`. Stored via `app.scrollantir.db.emit()` into Room.

| Source | Type | Data schema | Producer |
|---|---|---|---|
| `system.foreground` | duration | `{"app": "<package>", "app_label": "<human name>"}` | `UsageStatsPoller` |
| `system.screen` | duration | `{"state": "on"}` | `ScreenWatcher` |
| `system.unlocked` | duration | `{}` | `ScreenWatcher` (USER_PRESENT → SCREEN_OFF pair) |
| `system.unlock` | point | `{}` | `ScreenWatcher` (USER_PRESENT) |
| `youtube.shorts` | duration | `{}` | `ContentDetectorService` |
| `instagram.reels` | duration | `{}` | `ContentDetectorService` |
| `instagram.stories` | duration | `{}` | `ContentDetectorService` |
| `tiktok.feed` | duration | `{}` | `ContentDetectorService` |
| `detector.miss` | point | `{"package", "view_ids"}` | `ContentDetectorService` (throttled 60s/pkg) |

`app` is the stable package identifier (primary key for downstream joins, never changes across renames). `app_label` is PackageManager-resolved human-readable name — client caches aggressively and falls back to the package name if lookup fails. ReVanced YouTube emits under the same `youtube.shorts` source as stock YouTube.

## App architecture

```
MainActivity (Compose, AppRoot with AnimatedContent)
├─ TodayScreen (default route, ⚙ / ⏳ icons top-right)
├─ SettingsScreen (back arrow)
└─ TimelineScreen (back arrow, pinch-to-zoom hint)

TrackerForegroundService (FOREGROUND_SERVICE_TYPE_DATA_SYNC)
├─ UsageStatsPoller (Coroutine, every 2.5s, mutex-guarded)
├─ ScreenWatcher (BroadcastReceiver, runtime-registered)
└─ onDestroy: runBlocking(NonCancellable) { poller.flushCurrent(now) }

ContentDetectorService (AccessibilityService, when enabled)

ForwarderWorker (CoroutineWorker, periodic 15min)
CleanupWorker (CoroutineWorker, periodic 6h)

BootReceiver (respects persisted tracking-enabled pref)
```

### UsageStatsPoller (mutex-guarded)

- `pollOnce()` holds `mutex.withLock` for the duration of processing — serializes with external `flushCurrent` calls.
- At the start of each poll, drains `pendingScreenOffFlushMs` (set synchronously by ScreenWatcher on SCREEN_OFF). Flushes at the stored timestamp, rewinds `lastQuery` so any ACTIVITY_RESUMED since the screen-off gets reprocessed against a now-null `currentApp`.
- Exposes `UsageStatsPoller.currentForeground: StateFlow<CurrentForeground?>` for the Today/Timeline in-flight fold-in.
- Cached `labelFor(pkg)` via `ConcurrentHashMap`; PackageManager lookups done once per new package.

### ScreenWatcher

- `ACTION_SCREEN_ON` / `ACTION_SCREEN_OFF` → `system.screen` duration events
- `ACTION_USER_PRESENT` → `system.unlock` (point) + starts `system.unlocked` span
- `ACTION_SCREEN_OFF` also calls `UsageStatsPoller.scheduleScreenOffFlush(now)` — closes the in-flight foreground session synchronously (via the volatile flag the poller drains).

### ContentDetectorService

- Detection rules per target package (stock YT, ReVanced YT, Instagram, TikTok). See "Detection rules" below.
- Exposes `ContentDetectorService.currentMode: StateFlow<CurrentMode?>` for in-flight fold-in on Today.
- `onForegroundLeftTarget(endMs)` called from `UsageStatsPoller.flushCurrentLocked` when leaving a target app — uses the exact UsageStats event timestamp, not `System.currentTimeMillis()`.

### ForwarderWorker

- `SELECT * WHERE forwarded_at IS NULL LIMIT 500`
- POST with `Authorization: Bearer <token>` via OkHttp
- 2xx → `UPDATE events SET forwarded_at = now WHERE id IN (:ids)`
- 4xx except 408/429 → `Result.success()` without marking — preserves queue, stops infinite retry on bad token
- 5xx / 408 / 429 / IOException → `Result.retry()` with exponential backoff
- Settings Save triggers an immediate one-shot sync via `ForwarderWorker.syncNow()` so the user doesn't wait 15 min for the first batch.

## UI

### TodayScreen

- **Status pill** — small pulsing green dot + text when tracking is live
- **Now tile** — card showing the currently-foregrounded app (icon + label), elapsed time ticking at 1s (own `mutableLongStateOf` independent of the outer 10s tick to avoid negative-elapsed flashes after app switches)
- **Summary tiles** — phone time + unlock count, both for "today" (recomputed across midnight — see "Day-boundary handling")
- **Short-form card** — sums `youtube.shorts` / `instagram.reels` / `instagram.stories` / `tiktok.feed` events today, **folds in the live current mode** from `ContentDetectorService.currentMode`, clipped to `[startOfDay, now]`
- **Apps card** — sums `system.foreground` events today, folds in the live current foreground app, clipped to day boundaries, filtered through `EventFilter.isSignalApp` (hides systemui / inputmethod / scrollantir-itself, keeps launcher / all real apps), sorted desc, rendered with app icons + proportional bar
- **"Grant permissions" prompts** appear only when something is missing

#### Day-boundary handling

`startOfDayMs` is keyed on `LocalDate.now(zone)` and `zone` in a `remember` block. The 10s `nowMs` ticker drives `today`, which causes `remember` to recompute at calendar-day rollover. Leaving the app open past midnight correctly transitions to the new day's totals.

#### Aggregation pipeline

```
foregroundEventsSince(lookbackIso=24h-before-today-start)
    ↓
aggregateAppsClipped(events, inflight=currentForeground, windowStart=todayStart, windowEnd=now)
    ↓  clips each session to [windowStart, windowEnd], groups by app, sums
EventFilter.filterAppTotals (drop noise packages, <2s visits)
    ↓
AppTotal[] → UI
```

Same pattern for `aggregateModesClipped` with `inflightMode = ContentDetectorService.currentMode.value`.

### TimelineScreen

- 24-hour vertical strip, scrollable + pinchable
- Initial scale: **2 dp per minute** (120dp per hour = 2880dp total for the day)
- **Single-finger drag** = scroll. Powered by `Modifier.scrollable(state = rememberScrollableState { delta → scrollPx += delta, clamped })`. Gets fling momentum via `ScrollableDefaults.flingBehavior` (physics-based DecayAnimation) for free.
- **Two-finger pinch** = zoom. Custom `awaitPointerEventScope` loop:
  - Only consumes events when `pressed >= 2` AND `calculateZoom() != 1f`
  - Single-finger events flow unconsumed to `scrollable`
  - On pinch: computes `centroidMinute = (scrollPx + centroid.y) / dpPerMinPx` *before* updating `dpPerMin`; sets both `dpPerMin *= zoom` and `scrollPx = centroidMinute * newDpPerMinPx - centroid.y` in the same frame → smooth, no scrollState-maxValue-lag snappiness
  - Clamps `dpPerMin` to [0.5, 8]
- **Tap on a block** = opens ModalBottomSheet with icon + label (via `AppIconCache.rememberAppInfo`), raw package, start/end times, duration. Implemented with `Modifier.clickable`; on second-finger down, clickable cancels its gesture automatically and events flow to the pinch handler.
- **"Now" line** — red horizontal line at current time, position derived from `(nowMs - startOfDayMs) * dpPerMin`, re-renders on every `nowMs` tick
- **Stable color per app** — HSL hash of package name. Same app → same color forever.
- **Auto-scroll to "now - 40%" of viewport** on first open, once `viewportHeightPx` known (`onSizeChanged`).
- Scroll state is a plain `Float`, not `rememberScrollState`. Chosen so pinch can update both `dpPerMin` and `scrollPx` synchronously in the same frame. Lose Compose's scrollState maxValue machinery, gain synchronous state coordination.

### SettingsScreen

- Back arrow top-left
- Tracking control: Start/Pause button. Writes `KEY_TRACKING_ENABLED` to `SecurePrefs` so BootReceiver respects user's pause across reboots.
- Permissions section (Notifications / Usage access / Battery optimization / Accessibility)
- Sync card (last sync time + "Sync now" button)
- Server settings (URL + bearer token, `EncryptedSharedPreferences`, Save triggers immediate `ForwarderWorker.syncNow`)
- Version footer: `v${VERSION_NAME}  ·  built ${BUILD_TIME_MS}` — build timestamp changes on every compile, useful for verifying a fresh install actually landed

## Android 15 install workaround

Android 15's Enhanced Confirmation Mode blocks accessibility-service event delivery for apps installed via plain `adb install`. Symptoms: service binds, `onServiceConnected` fires, but `onAccessibilityEvent` never called.

Two layers of the spoof:

```kotlin
// app/build.gradle.kts — applies to Android Studio's Run button
android.installation {
    installOptions.addAll(listOf("-r", "-i", "com.android.vending"))
}

// Gradle task for CLI use
./gradlew :app:installDebugSpoofed
```

APK bytes, signing, runtime identical to a normal debug install. Only the `PackageManager.getInstallSourceInfo().getInstallingPackageName()` metadata changes. Every reinstall requires the spoof; APK updates typically reset accessibility toggles anyway.

## AccessibilityService configuration

`content_detector_config.xml`:

```xml
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeAllMask"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagReportViewIds|flagIncludeNotImportantViews"
    android:canRetrieveWindowContent="true"
    android:description="@string/content_detector_description"
    android:notificationTimeout="100" />
```

Manifest meta-data key **must** be `android.accessibilityservice` (not the fully-qualified class name). Using the wrong key silently drops the XML config.

No `packageNames` filter — it regressed detection on Pixel 9 even after the meta-data bug was fixed. In-code `rulesByPackage[pkg] ?: return` before the throttle handles filtering. Slightly more events reach our `onAccessibilityEvent` but the early-return is constant-time.

`flagReportViewIds` is required — without it `findAccessibilityNodeInfosByViewId` returns nothing even with a valid tree.

## Detection rules (from DigiPaws)

| Source | primaryViewId | requiresPresent | Event types |
|---|---|---|---|
| `youtube.shorts` (stock) | `com.google.android.youtube:id/reel_recycler` | — | WINDOW_CONTENT_CHANGED + WINDOW_STATE_CHANGED |
| `youtube.shorts` (ReVanced) | `app.revanced.android.youtube:id/reel_recycler` | — | same |
| `instagram.reels` | `com.instagram.android:id/clips_viewer_view_pager` | `clips_ufi_component` | VIEW_SCROLLED + CONTENT_CHANGED + STATE_CHANGED |
| `instagram.stories` | `com.instagram.android:id/reel_viewer_root` | — | same |
| `tiktok.feed` | `*` (sentinel — any event from pkg counts) | — | TYPES_ALL_MASK |

`detector.miss` auto-fires (throttled 60s/package) when a target app is foregrounded but no rule matches — emits the first 20 visible resource IDs so detectors can be updated against app redesigns.

## Permissions

| # | Permission | Purpose | Intent |
|---|---|---|---|
| 1 | `POST_NOTIFICATIONS` (A13+) | FGS notification | Runtime |
| 2 | `PACKAGE_USAGE_STATS` | foreground transitions | `ACTION_USAGE_ACCESS_SETTINGS` |
| 3 | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | service survival | `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` |
| 4 | Accessibility Service toggle | Shorts/Reels detection | `ACTION_ACCESSIBILITY_SETTINGS` |

Tracking is gated on #1 and #2. #3 recommended. #4 optional (tracking works without it, no Shorts/Reels distinction).

## Forwarder + cleanup

```
[T]      emit() inserts row, forwarded_at=NULL
         ↓ (up to 15 min later)
[T+Δ]    ForwarderWorker picks up in batch of ≤500
         ↓
[T+Δ']   2xx → UPDATE forwarded_at = now
         ↓ (up to 48h later)
[T+48h]  CleanupWorker DELETE WHERE forwarded_at IS NOT NULL AND forwarded_at < cutoff
```

4xx (non-retryable) → `Result.success()` without marking. Preserves queue for when the user fixes their token. No retry storm.

Local 48h retention exists so the Today aggregation works through server outages. Server is system of record for historical data.

## Bug fixes worth knowing about

### SCREEN_OFF flush (commits `ce85eb2`, `1b8192b`)

UsageStatsManager only fires `ACTIVITY_RESUMED` — never `ACTIVITY_ENDED`. Without a SCREEN_OFF-triggered flush, the last foreground app would stay `currentApp` in memory until the user unlocked and switched apps. A 2-hour locked period would then emit as a 2-hour Messages session. Fix:

1. `ScreenWatcher` on SCREEN_OFF writes `pendingScreenOffFlushMs = now` (volatile, synchronous)
2. Next `pollOnce()` under the mutex drains the flag: `flushCurrentLocked(pending)`, then `lastQuery = pending` so any post-unlock RESUMED gets re-processed against a now-null `currentApp`
3. The rewind matters: without it, a quick unlock-back-to-same-app would see `pkg == currentApp` against stale state and skip, then the flush would clear it — leaving the post-unlock session untracked until another app-switch

### Today day-pinning (commit `1b8192b`)

`startOfDayMs` was `remember { LocalDate.now().atStartOfDay(...).toInstant().toEpochMilli() }` with no key. App left open past midnight stayed on yesterday's numbers. Fix: key `remember` on `today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()`; ticker drives `today`.

### Short-form live fold-in (commit `1b8192b`)

Today's foreground totals folded in the live `currentForeground` session, but content-mode totals only summed completed DB rows. A 15-minute active Reels session was invisible on the card until you left Instagram. Fix: mirror the pattern — `ContentDetectorService.currentMode: StateFlow<CurrentMode?>`, folded into `aggregateModesClipped`.

### Mode end timestamp (commit `1b8192b`)

`notifyForegroundLeft()` was using `System.currentTimeMillis()` instead of the UsageStats event's `timeStamp`. Shorts/Reels sessions were overstated by up to 2.5s each (one poll interval). Threaded the exact `endMs` through.

### App label in events (commit `2cecb61`)

Server logs were unreadable — `com.paypal.android.p2pmobile` instead of `PayPal`. Event data now includes `app_label` (PackageManager lookup, cached). Stub server log uses it.

### Timeline labels (commit `9ef15b0`)

`TimelineBlockBox` and `BlockDetails` were using `humanizePackage(pkg)` which just title-cases the last dotted segment (`P2pmobile`, `Frontpage`). Fixed to use `AppIconCache.rememberAppInfo(pkg)` — same PackageManager resolution as the Today Apps card.

## Known issues from the Codex audit (not yet fixed)

These are lower-severity than the fixed ones. Documented here so they don't get forgotten.

### #4 ContentDetectorService.onDestroy races scope.cancel

`closeCurrentSessionBestEffort` launches an emit on the scope right before `scope.cancel()`. Final mode session can be lost on service teardown. Fix: `runBlocking(NonCancellable)` around the final emit, same pattern as TrackerForegroundService.onDestroy.

### #6 3-miss hysteresis can leave a stale mode open indefinitely

If leaving Reels produces 1-2 non-matching events and then the app becomes quiet, `current` never clears. Later in-app browsing gets misattributed as Reels. Fix: add a wall-clock timeout (e.g., if last matched >30s ago and at least one miss, close).

### #7 ScreenWatcher spans not seeded/flushed on service lifecycle

If tracking starts while screen is already on, `screenOnSince` stays null and the current span never emits. Service-stop mid-unlocked leaves the span open. Fix: seed from `PowerManager.isInteractive()` / `KeyguardManager.isKeyguardLocked()` on register; flush open spans in `TrackerForegroundService.onDestroy` alongside the existing poller flush.

### #8 ISO timestamp lexicographic sort edge cases

`Instant.toString()` has variable fractional precision. Lexicographic comparisons can misclassify rows at exact-second boundaries. Speculative — modern Android Instants are usually well-behaved — but if we see drift, normalize to fixed-width format or epoch millis.

## Build / toolchain

| Tool | Version | Notes |
|---|---|---|
| Android Gradle Plugin | 9.1.1 | `android.installation.installOptions` drives the install-spoof |
| Kotlin | 2.2.10 | |
| KSP | 2.2.10-2.0.2 | Room codegen |
| Compose BOM | 2026.02.01 | |
| Room | 2.7.1 | `fallbackToDestructiveMigration(dropAllTables = true)` |
| WorkManager | 2.10.0 | |
| OkHttp | 4.12.0 | |
| Security Crypto | 1.1.0-alpha06 | `EncryptedSharedPreferences` |
| Material Icons | Extended | `History`, `Settings`, `ArrowBack` |
| Lifecycle | 2.6.1 + runtime-compose | `LocalLifecycleOwner` from `androidx.lifecycle.compose` |
| kotlinx.coroutines | 1.9.0 | |
| min SDK | 24 | |
| target SDK | 36 | |

## Running / setup

See `docs/setup.md`.
