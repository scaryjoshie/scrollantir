# Location tracking — planned module

Captures where the phone is throughout the day, joined against app usage on the dashboard.

## Status

🚧 **Implementation in progress as of 2026-04-20.** Scope narrowed: collect locally, don't forward yet. Unblocks us from the HTTPS-server dependency. See "Current implementation plan" below.

### Cross-cutting note for the server / ingest agent

Design decision (2026-04-25): **no egress snap. Full-precision GPS reaches Postgres.** The earlier 4-decimal client snap was removed — this is a personal self-hosted setup where Josh owns both phone and server, so the privacy-preserving grid pixel was solving a problem that doesn't exist here, while costing the place-matching layer the resolution it needs to distinguish e.g. a specific classroom from the building it's in.

**Action for the server agent (still pending):** delete the lat/lng snap guard block at `30_ingest_api.sql:585-589` of the init migration. It's also dead code — its `p_source = 'phone.location'` exact-match never fires against our dotted `phone.location.reading`. Drop it via a new migration; behavior is unchanged either way.

Original blockers (both sidestepped by going local-only for now):

1. **Production HTTPS ingest server** — dodged by filtering `phone.location.*` and `phone.activity.*` out of the forwarder. Flip filter off when HTTPS exists.
2. **Dashboard use for 2+ weeks** — dodged by building the dashboard (LocationScreen) alongside collection, on the phone itself.

## Current implementation plan (2026-04-20)

Decisions made:

- **Tier 1 + Tier 2** shipped together. Tier 1 anchors readings at every activity transition; Tier 2 adds periodic sampling during movement states, gated by `setMinUpdateDistanceMeters` so stationary/in-place motion doesn't generate readings. Tuning: WALKING 20s/40m, RUNNING 15s/40m, BICYCLE 10s/60m, VEHICLE 10s/100m, STILL/UNKNOWN none.
- **Forwarding live (Supabase, TLS).** Earlier local-only gate is gone now that ingest is over HTTPS. Coordinates ship at full device precision — the prior 4-decimal egress snap was removed 2026-04-25; sub-meter fidelity is wanted for the place-matching layer. Server-side snap in the init migration is dead code (source-name mismatch) and slated for removal.
- **Map library: Google Maps SDK** via `maps-compose`. Compose-native, dark style baked in (`res/raw/maps_night.json`), clustering by identical grid-snapped coords so stacked readings render as one dot.
- **Bottom sheet shows only `phone.activity.state` rows**, sorted newest-first, 12-hour time format. Raw `phone.location.reading` rows populate the map dots; they don't appear in the feed. Tap a row to expand inline into the overlapping app-usage events for that window.

### Phased breakdown

**Phase 0 — dependencies & manifest**
- Add `play-services-location` and the chosen map library to `app/build.gradle.kts`
- Manifest permissions: `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `ACTIVITY_RECOGNITION`, `FOREGROUND_SERVICE_LOCATION`
- `TrackerForegroundService` foregroundServiceType: `dataSync` → `dataSync|location`
- Register `ActivityTransitionReceiver` in manifest
- If Google Maps: `MAPS_API_KEY` from `local.properties` (gitignored) via `manifestPlaceholders`

**Phase 1 — collection (`tracker/` package)**
- `ActivityWatcher.kt` — owns `ActivityRecognitionClient.requestActivityTransitionUpdates`. On ENTER transition: emit closed `phone.activity.state` duration for previous state, update `current`, notify `LocationWatcher.onActivityChange(newState)`.
- `ActivityTransitionReceiver.kt` — BroadcastReceiver for the PendingIntent; routes events back to `ActivityWatcher` via a shared flow.
- `LocationWatcher.kt` — `FusedLocationProviderClient`. `onActivityChange()` fires one `getCurrentLocation` (Tier 1 anchor) and reconfigures a periodic `requestLocationUpdates` (Tier 2) with a per-activity min-update-distance. Drop `accuracy_m > 200`. Emit `phone.location.reading` point event with `{lat, lng, accuracy_m, provider, reason}` at full device precision.
- `TrackerForegroundService.kt` — own both watchers, gate on `SecurePrefs.KEY_LOCATION_ENABLED` (default off). Flush open activity span in `onDestroy` under `runBlocking(NonCancellable)`. `stop()` the LocationWatcher (removes periodic updates) in both disable-path and onDestroy.

**Phase 2 — forwarder gate**
- `ForwarderWorker.kt` SELECT filter: `AND source NOT LIKE 'phone.location.%' AND source NOT LIKE 'phone.activity.%'`.

**Phase 3 — Settings**
- Fourth permission card: "Location (background)" → app detail settings intent
- Fifth permission card: "Physical activity" → runtime `ACTIVITY_RECOGNITION` prompt
- Toggle row: "Enable location tracking" (stored in `SecurePrefs`, default off). On/off starts/stops watchers.

**Phase 4 — LocationScreen (UI)**
- `TodayScreen.kt`: add Location icon (`Icons.Filled.Place`) to top-right icon bar. Swap `History` → `Timeline` for the timeline entry. Order: `Timeline · Location · Settings`.
- `LocationScreen.kt` (new):
  - Top bar: back arrow, date label, chevrons for prev/next day
  - Map area (~65% height): markers per reading, dashed polyline between consecutive readings colored by the activity state of the segment between them. Initial camera fits the day's bounds.
  - Bottom sheet (`BottomSheetScaffold`, peek ~30%, draggable to 85%): merged chronological feed of `phone.activity.state` + `phone.location.reading` rows. Tap a row → expand inline with overlapping foreground/content-mode events for that window.
  - Stable activity-state color palette (gray=still, green=walking, orange=vehicle, blue=bicycle, red=running).

**Phase 5 — polish**
- `EventFilter` additions if noise appears
- Auto-scroll bottom sheet to current hour on open
- "No readings yet today" empty state

**LOC budget:** ~640 LOC total. ~4–5 hours.

## What this enables

- "Where was I when I scrolled Shorts for 2h?" — app-usage map
- Commute time via activity + location change
- Time at home vs. out-of-house
- Frequently-visited places (gym, coffee shops, friends' houses)
- Cross-reference: "Reddit time at office vs. cafe"
- **Narrative timeline**: "Home 07:30–09:15 → walked 09:15–09:35 → Cafe Loma 09:35–11:10 → biked 11:10–11:45 → Office 11:45–17:30 → ..."

## Fit with the schema

Same event shape as everywhere else. Proposed sources:

| Source | Type | Data | Producer |
|---|---|---|---|
| `phone.location.reading` | point | `{lat, lng, accuracy_m, provider}` | `LocationWatcher` |
| `phone.location.visit` | duration | `{lat, lng, radius_m}` | (v2) visit clusterer |
| `phone.activity.state` | duration | `{state: "still" \| "walking" \| "vehicle" \| ...}` | (v2) Activity Recognition API |

Points come from FusedLocationProviderClient; visits are computed later either on-device (v2) or server-side by clustering nearby readings.

## Core architectural insight: activity drives location cadence

Naive continuous GPS at 10s = ~8,640 samples/day + ~25% daily battery. Overkill for a narrative view.

Instead, pair **ActivityRecognitionClient** (event-driven, near-zero battery, sensor-fused by the OS) with **demand-driven location sampling**:

```
Activity Recognition: always on, fires only on state transitions.
  States: STILL, WALKING, RUNNING, IN_VEHICLE, ON_BICYCLE, UNKNOWN
  Volume: ~20–50 transitions/day
  Cost: ~negligible (OS sensor fusion, no app polling)

Location sampling policy — driven by current activity:
  On every state transition → take one location reading.
    (Anchors the endpoints of walk/bike/drive segments.)
  During movement states (WALKING/RUNNING/BICYCLE/VEHICLE):
    Sample every 20–30s for path shape.
  During STILL:
    No sampling. Next reading comes at the transition out of STILL.
```

Result: ~80–150 location events/day instead of 8,640. Daily battery overhead: ~3–7%. Same narrative richness.

### Why not dense GPS alone

Raw GPS at 10s with no activity signal still requires inferring activity from speed/path heuristics, which is error-prone (walking vs. biking slowly, sitting in a cafe vs. stuck in traffic). The API-provided activity state is authoritative and costs nothing.

### Narrative-rendering pipeline

This is dashboard-layer work, not collection:

1. Segment the day by activity-state transitions.
2. For each segment:
   - `STILL` + stable location cluster (readings within 100m) → "Visit at [place]"
   - `WALKING/BIKING/DRIVING` → "Traveled from A to B"
3. Name places via:
   - User-configured geofences (home, work, gym)
   - Auto-inferred (the 5 locations where you've spent >30min on 5+ different days get auto-named)
   - Last resort: reverse-geocode to street address
4. Render emoji timeline:
   ```
   🏠 Home                 07:30 – 09:15
   🚶 Walk  1.2mi          09:15 – 09:35
   ☕ Cafe Loma             09:35 – 11:10
   🚴 Bike  4.5mi          11:10 – 11:45
   🏢 Office               11:45 – 17:30
   🍽 Dinner               17:45 – 19:00
   ```

## Two build tiers — pick at implementation time

### Tier 1: narrative-only (default, ~3 hr)

Activity Recognition + **one location reading per transition**. No periodic sampling during movement.

- Volume: ~40 events/day
- Battery: ~2–4% daily overhead
- Renders: "Walked from Home to Cafe Loma, 09:15 → 09:35, ~1.2mi straight-line"
- No route polylines. Distance is A-to-B great-circle, which is close enough for the dashboard's "biking to the office vs. the gym" use case.

This is likely all you need. Ship this; add Tier 2 later only if you find yourself wanting a map view.

### Tier 2: narrative + path (~4 hr)

Same as Tier 1, plus periodic sampling during movement states (20–30s depending on activity). Enables:

- Accurate distance (sum of segments)
- Route polyline rendering on a map view
- Speed/pace per segment

Volume: ~100 events/day. Battery: ~3–7% daily overhead.

The cadence table below is Tier 2. For Tier 1, just ignore the "During movement" row — there is no periodic sampling.

## Implementation (both tiers)

**~3–4 hours of work depending on tier** — Activity Recognition + location sampling.

### Permissions (new)

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />
```

`ACCESS_BACKGROUND_LOCATION` is Google's most-restricted runtime permission. On Pixel, it appears as a separate "Allow all the time" toggle reached via Settings → Location → App permissions. Compound gauntlet on top of the existing Restricted Settings / accessibility dance.

### Foreground service type

Our `TrackerForegroundService` currently declares `dataSync`. Add `location`:

```xml
<service
    android:name=".tracker.TrackerForegroundService"
    android:foregroundServiceType="dataSync|location" />
```

Pipe-separator lets us declare both; location access from an FGS with `location` type bypasses some background-location restrictions.

### ActivityWatcher

Companion of `LocationWatcher`, also owned by `TrackerForegroundService`. Subscribes to `ActivityRecognitionClient.requestActivityTransitionUpdates`, emits `phone.activity.state` duration events on enter/exit. Holds the "current state" in memory so LocationWatcher can consult it for its sampling policy.

```kotlin
class ActivityWatcher(
    private val context: Context,
    private val dao: EventDao,
    private val scope: CoroutineScope,
    private val onStateChange: (ActivityState) -> Unit
) {
    private val client = ActivityRecognition.getClient(context)
    @Volatile var current: ActivityState = ActivityState.UNKNOWN
        private set
    private var currentStartedAt: Instant = Instant.now()

    // On each transition ENTER: emit a closed duration event for the
    // previous state spanning [currentStartedAt, now], then update
    // current + currentStartedAt.
    // Notify LocationWatcher so it can change its sampling cadence.
}

enum class ActivityState { STILL, WALKING, RUNNING, ON_BICYCLE, IN_VEHICLE, UNKNOWN }
```

### LocationWatcher

Class inside `app.scrollantir.tracker`, owned by `TrackerForegroundService` alongside the existing `UsageStatsPoller` and `ScreenWatcher`.

```kotlin
class LocationWatcher(
    private val context: Context,
    private val dao: EventDao,
    private val scope: CoroutineScope
) {
    private val client = LocationServices.getFusedLocationProviderClient(context)
    private val DEDUP_METERS = 30.0

    // Called by ActivityWatcher on every transition. Triggers an
    // immediate single-shot location request to anchor the segment
    // endpoint, then reconfigures the update cadence for the new state.
    fun onActivityChange(newState: ActivityState) {
        requestSingleReading()  // anchor the transition
        val interval = when (newState) {
            ActivityState.WALKING, ActivityState.RUNNING -> 30_000L
            ActivityState.ON_BICYCLE -> 20_000L
            ActivityState.IN_VEHICLE -> 30_000L
            ActivityState.STILL, ActivityState.UNKNOWN -> null  // no periodic sampling
        }
        if (interval == null) stopPeriodic() else startPeriodic(interval)
    }

    private fun startPeriodic(intervalMs: Long) {
        val request = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, intervalMs)
            .setMinUpdateDistanceMeters(DEDUP_METERS.toFloat())
            .build()
        client.requestLocationUpdates(request, callback, Looper.getMainLooper())
    }

    // ... stopPeriodic, requestSingleReading, callback emitting phone.location.reading
}
```

Cadence summary:

| Activity | Sampling | Rationale |
|---|---|---|
| STILL | Only at transition | Nothing interesting between start-still and next move |
| WALKING / RUNNING | 30s | Human walking speed → 30m per sample → clean path |
| ON_BICYCLE | 20s | Higher speed needs denser samples for path fidelity |
| IN_VEHICLE | 30s | Vehicle covers enough that 30s is fine for commute paths |
| UNKNOWN | None | Don't waste samples if the OS can't classify |

Always at `PRIORITY_BALANCED_POWER_ACCURACY` (~100m accuracy, wifi-assisted). `PRIORITY_HIGH_ACCURACY` uses GPS aggressively and burns battery; we don't need room-level precision for the narrative.

### Settings UI

Fourth permission card alongside the existing three in `SettingsScreen.kt`:

```kotlin
PermissionRow(
    "Location (background)",
    granted = hasBackgroundLocationPermission(context),
    onGrant = { /* open Settings.ACTION_APPLICATION_DETAILS_SETTINGS */ }
)
```

Plus a user-facing enable/disable toggle stored in `SecurePrefs`. Unlike tracking-on-or-off (which is on by default), **location should be opt-in**. User toggles in Settings → LocationWatcher registers; toggle off → unregisters.

### Privacy features in v1

- **Accuracy gate**: drop readings with `accuracy_m > 200` — they're noise (tunnel, indoor with weak GPS).
- **No egress snap**: full-precision coords ship to Supabase. Self-hosted single-user deployment, full fidelity wanted for the place-matching layer. If a future shared deployment ever changes the threat model, reintroduce a snap on the egress path.

## Full version (deferred, ~1 week)

Build on top of the minimal cut once real data has been collected for a few weeks.

- **Activity Recognition API** — `phone.activity.state` events distinguishing still / walking / running / vehicle / bicycle. Virtually zero battery cost (sensor-driven, OS-managed).
- **On-device visit clustering** — server-side is simpler but burns bandwidth. DBSCAN-style: consecutive readings within N meters over M minutes = one "visit." Emit `phone.location.visit` duration events instead of raw readings.
- **Geofence API for named places** — user-configured or inferred (the 5 places you spend most of your time get named automatically: home, work, gym, Mom's, etc.).
- **Dashboard map view** — heatmap layer, trajectory line, place-categorized time totals.

## The "skip the implementation entirely" alternative

**Google Timeline + Takeout** already captures everything location.

- Maps → Your Timeline: view in-app, always fresh
- [takeout.google.com](https://takeout.google.com) → YouTube + Location History → schedule weekly export

A weekly cron can pull the Takeout export, parse the JSON, and import into Postgres as `mac.gtakeout.location` events. You'd get the same data for:

- Zero battery impact
- Zero implementation code
- Zero permission ceremony
- 1-week latency (vs. live)

The philosophical tradeoff: scrollantir's goal is "own your data." Google has location history regardless of what we do; Takeout just lets us read it. Pragmatic path is **use Takeout for MVP, build custom collection only if the data proves valuable and realtime matters**.

## Permissions runbook (when the time comes)

1. Grant "Allow all the time" via Settings → Apps → Scrollantir → Permissions → Location → Allow all the time
2. On Android 14+: may need to re-grant after each APK reinstall (Restricted Settings again)
3. Some Pixel firmware versions prompt a scary "Scrollantir will have access to your location even when you're not using the app" confirmation dialog — expected, not a regression

## Data model notes

- **`phone.location.reading`** is a point event (duration_s = 0) even though location is "state over time." The point is a sample; clustering is a separate concern. Storing samples raw lets us change our mind about clustering later.
- Client already sends `id` as UUID v4, so the standard `ON CONFLICT (id) DO NOTHING` dedup protects against forwarder retries duplicating readings server-side.
- `source_tags` for cross-cutting categories: `home`, `work`, `travel` tags applied by query-time JOIN against a user-maintained places table (not coords stored in source_tags).

## Security TODOs before enabling

- [ ] Real HTTPS server (non-negotiable)
- [ ] Consider encrypt-at-rest for location rows in Postgres beyond the default (pgcrypto column-level encryption)
- [ ] Ingest endpoint validates lat/lng bounds, rejects obvious garbage
- [ ] Dashboard UI puts location behind an auth layer (can't just sniff it from a home-network cookie)
- [ ] Retention policy: do we keep location forever, or drop rows after N months? Probably N=24 months.
