# Location tracking — planned module

Captures where the phone is throughout the day, joined against app usage on the dashboard. Not yet built; deferred until prerequisites are in place.

## Status

🚧 Planned, blocked on:

1. **Production HTTPS ingest server** (not the LAN stub). Cleartext posting of home coordinates to a LAN IP is a genuine security mistake.
2. **Dashboard in use for 2+ weeks** — until you know what questions you'd ask location for, we don't know what resolution / cadence matters.

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

## Minimal implementation (first cut)

**~4 hours of work** — Activity Recognition + adaptive location sampling.

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

- **Client-side grid snap**: before emitting, round lat/lng to nearest 100m (~3 decimals). Server never stores exact coordinates. Enough fidelity for "at home vs. at work" without exposing the specific room you sit in.
- **Accuracy gate**: drop readings with `accuracy_m > 200` — they're noise (tunnel, indoor with weak GPS).

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
