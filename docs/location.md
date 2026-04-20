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

## Fit with the schema

Same event shape as everywhere else. Proposed sources:

| Source | Type | Data | Producer |
|---|---|---|---|
| `phone.location.reading` | point | `{lat, lng, accuracy_m, provider}` | `LocationWatcher` |
| `phone.location.visit` | duration | `{lat, lng, radius_m}` | (v2) visit clusterer |
| `phone.activity.state` | duration | `{state: "still" \| "walking" \| "vehicle" \| ...}` | (v2) Activity Recognition API |

Points come from FusedLocationProviderClient; visits are computed later either on-device (v2) or server-side by clustering nearby readings.

## Minimal implementation (first cut)

**~3 hours of work.**

### Permissions (new)

```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
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

### LocationWatcher

Class inside `app.scrollantir.tracker`, owned by `TrackerForegroundService` alongside the existing `UsageStatsPoller` and `ScreenWatcher`.

```kotlin
class LocationWatcher(
    private val context: Context,
    private val dao: EventDao,
    private val scope: CoroutineScope
) {
    private val client = LocationServices.getFusedLocationProviderClient(context)
    private var lastLat: Double? = null
    private var lastLng: Double? = null
    private val DEDUP_METERS = 50.0

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val loc = result.lastLocation ?: return
            val moved = lastLat?.let { distanceM(it, lastLng!!, loc.latitude, loc.longitude) }
            if (moved != null && moved < DEDUP_METERS) return

            lastLat = loc.latitude
            lastLng = loc.longitude
            scope.launch {
                emit(
                    dao = dao,
                    source = "phone.location.reading",
                    durationS = 0.0,
                    data = mapOf(
                        "lat" to loc.latitude,
                        "lng" to loc.longitude,
                        "accuracy_m" to loc.accuracy,
                        "provider" to "fused"
                    )
                )
            }
        }
    }

    fun register() {
        val request = LocationRequest.Builder(
            Priority.PRIORITY_BALANCED_POWER_ACCURACY, 60_000L
        ).setMinUpdateDistanceMeters(DEDUP_METERS.toFloat()).build()
        client.requestLocationUpdates(request, callback, Looper.getMainLooper())
    }

    fun unregister() { client.removeLocationUpdates(callback) }
}
```

Cadence: `PRIORITY_BALANCED_POWER_ACCURACY` at 60s is the sweet spot — ~100m accuracy, wifi-assisted, ~5–10% daily battery overhead. `PRIORITY_LOW_POWER` is near-free but ~1km accuracy (mostly useless). `PRIORITY_HIGH_ACCURACY` burns battery aggressively.

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
