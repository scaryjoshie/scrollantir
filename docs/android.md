# Android — Collection Spec

Primary focus of v1. Single sideloaded APK does everything. No dependency on aw-android.

Target device: Google Pixel 9. Clean Android (no OEM battery killer). Likely Android 14 or 15.

## Sources emitted

All written to the local Room queue. Schema per [architecture.md](architecture.md): `{id, device, source, timestamp_utc, duration_s, data_json}`. `device` is always `phone`.

| Source | Type | Data schema |
|---|---|---|
| `system.foreground` | duration | `{"app": "<package>"}` |
| `system.screen` | duration | `{"state": "on"}` |
| `system.unlocked` | duration | `{}` |
| `system.unlock` | point | `{}` |
| `youtube.shorts` | duration | `{}` |
| `youtube.video` | duration | `{}` |
| `instagram.reels` | duration | `{}` |
| `instagram.feed` | duration | `{}` |
| `instagram.stories` | duration | `{}` |
| `tiktok.feed` | duration | `{}` |
| `detector.miss` | point | `{"package": "<pkg>", "view_ids": ["..."]}` |

Explicitly **not** in v1:
- URL tracking inside Chrome/Firefox on Android
- Notification tracking
- Per-video metadata extraction (title, channel) — defer to v2 enrichment job
- Input event counts

## Decision: custom app, not aw-android fork

aw-android is flagged "early stage" by its own listing. Everything valuable it does is ~200 lines on top of UsageStatsManager. We're writing a forwarder anyway. DigiPaws (GPLv3) provides the Shorts/Reels detectors.

## App architecture

```
┌─────────────────────────────────────────────────────────┐
│ MainActivity (UI)                                       │
│ ├─ First-run onboarding (permissions dance)             │
│ ├─ Status screen (queue size, last forward, etc.)       │
│ └─ Settings (server URL, token management)              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ TrackerForegroundService                                │
│ FOREGROUND_SERVICE_TYPE_DATA_SYNC, persistent notif.    │
│                                                         │
│ ├─ UsageStatsPoller (Coroutine, every 2–3s)             │
│ │   └─ emits system.foreground                          │
│ │                                                       │
│ ├─ ScreenReceiver (BroadcastReceiver, runtime-registered)
│ │   ├─ ACTION_SCREEN_ON / _OFF → system.screen          │
│ │   ├─ ACTION_USER_PRESENT → system.unlock (point)      │
│ │   └─ USER_PRESENT + SCREEN_OFF pairs → system.unlocked│
│ │                                                       │
│ └─ LivenessWriter (Coroutine, every 60s)                │
│     └─ writes "service alive at T" to SharedPrefs       │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ ContentDetectorService (AccessibilityService)           │
│ ├─ packageNames filter: YouTube | Instagram | TikTok    │
│ ├─ onAccessibilityEvent throttle (500ms)                │
│ ├─ findAccessibilityNodeInfosByViewId — detection       │
│ └─ state machine → youtube.* / instagram.* / tiktok.*   │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Room database (local queue)                             │
│ events(id, device, source, timestamp_utc,               │
│        duration_s, data_json)                           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ ForwarderWorker (PeriodicWorkRequest, every 15min)      │
│ ├─ NetworkType.CONNECTED constraint                     │
│ ├─ batch size 500                                       │
│ ├─ POST + DELETE on 200                                 │
│ └─ failure → WorkManager retries with exponential backoff
└─────────────────────────────────────────────────────────┘
```

## Manifest essentials

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
<uses-permission android:name="android.permission.PACKAGE_USAGE_STATS" tools:ignore="ProtectedPermissions" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />

<queries>
  <intent>
    <action android:name="android.intent.action.MAIN" />
  </intent>
</queries>
```

## Data emitters

### `system.foreground` — UsageStatsManager poller

Inside `TrackerForegroundService` as a coroutine. Every ~2–3 seconds:

```kotlin
val usm = getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
val now = System.currentTimeMillis()
val events = usm.queryEvents(lastQuery, now)
val ev = UsageEvents.Event()
while (events.getNextEvent(ev)) {
    when (ev.eventType) {
        UsageEvents.Event.ACTIVITY_RESUMED -> transitionTo(ev.packageName, ev.timeStamp)
        UsageEvents.Event.ACTIVITY_PAUSED -> endCurrent(ev.timeStamp)
    }
}
lastQuery = now
```

State: `current: String?` (package), `startedAt: Instant?`.

On `transitionTo(newPkg, t)`:
- If `current != null && current != newPkg`: emit closed session (source=`system.foreground`, data={app: current}, duration = t - startedAt)
- Set `current = newPkg`, `startedAt = Instant.ofEpochMilli(t)`

Permission: `PACKAGE_USAGE_STATS` — `Settings.ACTION_USAGE_ACCESS_SETTINGS` intent.

Polling cadence: 2–3 seconds. UsageStats has ~1s granularity; polling faster wastes battery.

### `system.screen` — raw screen state

Runtime-registered BroadcastReceiver (manifest registration is blocked for these actions since Android 8):

```kotlin
class ScreenReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_SCREEN_ON -> screenOn(Instant.now())
            Intent.ACTION_SCREEN_OFF -> screenOff(Instant.now())
            Intent.ACTION_USER_PRESENT -> userPresent(Instant.now())
        }
    }
}

val filter = IntentFilter().apply {
    addAction(Intent.ACTION_SCREEN_ON)
    addAction(Intent.ACTION_SCREEN_OFF)
    addAction(Intent.ACTION_USER_PRESENT)
}
registerReceiver(screenReceiver, filter)
```

State: `screenOnSince: Instant?`. On SCREEN_OFF: emit `system.screen` covering the prior on→off span.

### `system.unlocked` and `system.unlock`

State: `unlockedSince: Instant?`.

On `USER_PRESENT`:
- Emit `system.unlock` (point, duration=0)
- Set `unlockedSince = Instant.now()`

On `SCREEN_OFF`:
- If `unlockedSince != null`: emit `system.unlocked` covering `unlockedSince → now`, clear `unlockedSince`

### Content detector AccessibilityService

`res/xml/content_detector_config.xml`:

```xml
<accessibility-service
    xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeWindowStateChanged|typeWindowContentChanged"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:notificationTimeout="100"
    android:packageNames="com.google.android.youtube|com.instagram.android|com.zhiliaoapp.musically"
    android:canRetrieveWindowContent="true" />
```

`packageNames` filter is **critical** for battery — without it we'd receive UI events from every app.

Service skeleton:

```kotlin
class ContentDetectorService : AccessibilityService() {
    private var current: ContentMode? = null
    private var modeStart: Instant = Instant.now()
    private var lastCheck: Long = 0L

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val now = System.currentTimeMillis()
        if (now - lastCheck < 500) return
        lastCheck = now

        val root = rootInActiveWindow ?: return
        val pkg = event.packageName?.toString() ?: return

        val detected = when (pkg) {
            "com.google.android.youtube"  -> detectYouTube(root)
            "com.instagram.android"        -> detectInstagram(root)
            "com.zhiliaoapp.musically"     -> ContentMode("tiktok.feed")
            else                           -> null
        }

        if (detected == null) {
            // Target package was foreground but no rule matched
            emit("detector.miss", durationS = 0.0,
                 data = mapOf("package" to pkg, "view_ids" to topViewIds(root)))
            return
        }

        if (detected != current) {
            current?.let { c ->
                emit(c.source,
                     start = modeStart,
                     durationS = secondsSince(modeStart),
                     data = emptyMap())
            }
            current = detected
            modeStart = Instant.now()
        }
    }

    override fun onInterrupt() {}
}

data class ContentMode(val source: String)   // e.g. "youtube.shorts"
```

**Detector logic ported from DigiPaws** (GPLv3, https://github.com/nethical6/digipaws). File `CREDITS.md` with attribution.

Current resource IDs (subject to drift — defer to DigiPaws for current truth):
- YouTube Shorts: `com.google.android.youtube:id/reel_recycler` (fallbacks: `reel_watch_player`, `shorts_container`)
- Instagram Reels: `com.instagram.android:id/clips_viewer_view_pager` (fallbacks: `clips_viewer`, `reels_viewer`)

**Always recycle nodes** — `AccessibilityNodeInfo` holds native refs:

```kotlin
fun hasNodeId(root: AccessibilityNodeInfo, id: String): Boolean {
    val nodes = root.findAccessibilityNodeInfosByViewId(id)
    val found = nodes.isNotEmpty()
    nodes.forEach { it.recycle() }
    return found
}
```

## Room database

```kotlin
@Entity(tableName = "events")
data class EventRow(
    @PrimaryKey val id: String,           // UUID v4
    val device: String,                    // "phone"
    val source: String,                    // "system.foreground", "youtube.shorts", etc.
    @ColumnInfo(name = "timestamp_utc") val timestampUtc: String,
    @ColumnInfo(name = "duration_s") val durationS: Double,
    @ColumnInfo(name = "data_json") val dataJson: String
)

@Dao
interface EventDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(event: EventRow)

    @Query("SELECT * FROM events ORDER BY timestamp_utc ASC LIMIT :limit")
    suspend fun nextBatch(limit: Int): List<EventRow>

    @Query("DELETE FROM events WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)

    @Query("SELECT COUNT(*) FROM events")
    suspend fun count(): Int
}
```

Emit helper used by all watchers:

```kotlin
suspend fun emit(
    source: String,
    start: Instant = Instant.now(),
    durationS: Double = 0.0,
    data: Map<String, Any> = emptyMap()
) {
    val row = EventRow(
        id = UUID.randomUUID().toString(),
        device = "phone",
        source = source,
        timestampUtc = start.toString(),
        durationS = durationS,
        dataJson = moshi.adapter(Map::class.java).toJson(data)
    )
    db.events().insert(row)
}
```

No `sent` column. No checkpoint. Queue contents == unsent events.

## Forwarder (WorkManager)

```kotlin
class ForwarderWorker(ctx: Context, params: WorkerParameters) :
    CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val batch = db.events().nextBatch(500)
        if (batch.isEmpty()) return Result.success()

        val payload = batch.map { e ->
            mapOf(
                "id" to e.id,
                "device" to e.device,
                "source" to e.source,
                "timestamp" to e.timestampUtc,
                "duration_s" to e.durationS,
                "data" to JSONObject(e.dataJson)
            )
        }

        val response = httpClient.postJson(
            url = "$serverUrl/ingest",
            headers = mapOf("Authorization" to "Bearer $token"),
            body = payload
        )

        return if (response.code == 200) {
            db.events().deleteByIds(batch.map { it.id })
            Result.success()
        } else {
            Result.retry()
        }
    }
}

// Enqueue at service startup:
val work = PeriodicWorkRequestBuilder<ForwarderWorker>(15, TimeUnit.MINUTES)
    .setConstraints(
        Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
    )
    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
    .build()

WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
    "scrollantir-forwarder",
    ExistingPeriodicWorkPolicy.KEEP,
    work
)
```

15-minute minimum is WorkManager's lower bound. Acceptable staleness for our use case.

## Permissions dance (onboarding)

First-run screen walks through these in order, with visual status indicator for each:

| # | Permission | Why | Settings intent |
|---|---|---|---|
| 1 | POST_NOTIFICATIONS (A13+) | Foreground service notification | Runtime prompt |
| 2 | Usage Access | `system.foreground` | `ACTION_USAGE_ACCESS_SETTINGS` |
| 3 | Accessibility Service | `youtube.*` / `instagram.*` / `tiktok.*` | `ACTION_ACCESSIBILITY_SETTINGS` |
| 4 | Ignore Battery Optimization | Keep service alive | `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` |

Pixel-specific note: Pixel runs near-AOSP, no manufacturer-specific battery killer. The Samsung "Never sleeping apps" step from generic Android guidance does not apply.

On each launch of MainActivity, re-check status of 1–4 and flag any that regressed (rare on Pixel but happens after some OTAs).

## Battery defense

Three lines of defense:

1. **Foreground service** with persistent notification (`FOREGROUND_SERVICE_TYPE_DATA_SYNC`).
2. **Battery optimization exception** (permission #4 above).
3. **Boot receiver** (`RECEIVE_BOOT_COMPLETED` → `BootBroadcastReceiver` → `startForegroundService()`).

## Distribution

Sideload only. Play Store rejects AccessibilityService for usage-tracking purposes.

Build: Android Studio → signed APK (release, own keystore).
Install: `adb install -r app-release.apk`.
Update: same command — same keystore = signature matches = update rather than reinstall.

## Build order

Each stage has a clear verification gate before adding the next.

### Stage 1 — skeleton with foreground service and UsageStats
- App with MainActivity, TrackerForegroundService, BootReceiver
- UsageStatsPoller logs foreground changes to Logcat (no Room yet)
- Permission onboarding for #1, #2, #4
- **Verify**: `adb logcat -s ScrollantirTracker`, switch apps on phone, see "foreground: com.X" lines

### Stage 2 — Room queue + screen events
- Add Room, EventDao, `emit()` helper
- Wire UsageStatsPoller to emit instead of log
- Add ScreenReceiver with `system.screen`, `system.unlocked`, `system.unlock`
- MainActivity shows queue size
- **Verify**: scroll phone for ~5 min, queue count is sane and durations look right

### Stage 3 — Forwarder against stub server
- Stub FastAPI on Mac, accessed by Pixel via Mac's LAN IP
- WorkManager ForwarderWorker
- Token in EncryptedSharedPreferences
- **Verify**: airplane mode on (queue grows), airplane mode off (queue drains), restart phone (no dupes)

### Stage 4 — Content detector AccessibilityService
- `ContentDetectorService` scaffold
- Port DigiPaws YouTube detector → `youtube.shorts` / `youtube.video`
- Port Instagram detector → `instagram.reels` / `instagram.feed` / `instagram.stories`
- TikTok → `tiktok.feed`
- `detector.miss` diagnostic
- **Verify**: scroll Shorts 2 min → normal video 2 min → scroll Reels 1 min → three correctly-typed events

### Stage 5 — onboarding polish + production server
- Real onboarding UI with per-permission status cards
- Reboot Pixel, verify auto-restart and accessibility still on
- 24h soak test, no gaps
- Switch forwarder URL from LAN-stub to real server

After Stage 3, the app is usable — system-level data flowing into your server. Stage 4 is the in-app detection bonus. Stage 5 is polish.

## Known unknowns to resolve during Stage 1

- Exact UsageEvents semantics when the phone enters doze and wakes — do we get a PAUSED event, or just missing events? May need a "if no events for >60s, close out current session as of last heartbeat" rule.
- Whether `ACTION_USER_PRESENT` / `ACTION_SCREEN_OFF` pairing is reliable in doze. Test on Pixel before committing to the `system.unlocked` design.

## References

- DigiPaws (GPLv3): https://github.com/nethical6/digipaws — detector source of truth
- UsageStatsManager: https://developer.android.com/reference/android/app/usage/UsageStatsManager
- WorkManager periodic work: https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work
- AccessibilityService: https://developer.android.com/guide/topics/ui/accessibility/service
