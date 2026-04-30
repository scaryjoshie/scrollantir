package app.scrollantir.tracker

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import app.scrollantir.db.EventDao
import app.scrollantir.db.emit
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.time.Instant
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Location collector with **Tier 1 anchors** + **Tier 2 path sampling**.
 *
 * Tier 1: one single-shot reading on every activity transition
 * (`requestSingleReading`), which anchors the endpoint of a motion segment.
 *
 * Tier 2: during movement states, additionally subscribe to periodic
 * updates gated by `setMinUpdateDistanceMeters` so we only record samples
 * once the user has physically moved. Pacing around the room produces one
 * reading at transition time and nothing else; a real commute produces a
 * reading every 40–100m (tuned per activity).
 *
 * Filter pipeline (in `recordReading`, gates applied in order):
 *   1. **Accuracy** — drop `accuracy > 50m`. Tightened 2026-04-29 from 200m
 *      to keep optimistic-but-wrong WiFi/cell fixes out.
 *   2. **GPS attestation** — drop fixes that don't expose satellite-derived
 *      fields (`hasVerticalAccuracy` or `hasSpeed && hasBearing`). This is
 *      the cleanest way to distinguish a true GPS fix from a Fused-WiFi /
 *      Fused-cell triangulation, which the chip otherwise also stamps with
 *      `provider = "fused"` and a small accuracy radius.
 *   3. **Speed-based outlier rejection** — implied speed from the previous
 *      accepted reading must be plausible for the current activity state.
 *      Skipped for the first reading after an activity transition (e.g.,
 *      first vehicle GPS fix is legitimately tens of meters from where the
 *      phone was sitting).
 *
 * Privacy posture:
 *   - PRIORITY_HIGH_ACCURACY (GPS-led; coalesces with other apps already
 *     keeping the chip hot, e.g. Life360, so marginal battery cost is small
 *     when another high-accuracy subscriber is active)
 *   - Real coordinates persisted locally and shipped to the runtime
 *     stack as-is — self-hosted single-user setup, full precision wanted
 *     for place matching and dashboard fidelity.
 */
class LocationWatcher(
    private val context: Context,
    private val dao: EventDao,
    private val scope: CoroutineScope
) {
    private val client: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(context)

    private val periodicCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            // `closed` guards against callbacks already in flight when
            // stop() is called. scope.isActive alone isn't enough because
            // the service scope stays alive when location is merely
            // disabled (toggle-off doesn't tear down the service).
            if (closed || !scope.isActive) return
            val loc = result.lastLocation ?: return
            recordReading(loc, reason = "periodic")
        }
    }

    @Volatile
    private var periodicActive: Boolean = false

    @Volatile
    private var closed: Boolean = false

    @Volatile
    private var currentActivity: ActivityState = ActivityState.UNKNOWN

    // The most recently *accepted* reading — what subsequent readings get
    // speed-gated against. Updated only when a reading clears every filter.
    @Volatile
    private var lastAccepted: AcceptedReading? = null

    // Set true on every activity transition. The next reading bypasses the
    // speed gate (a vehicle's first GPS fix may legitimately be tens of
    // meters from where the device was sitting still). Cleared after one
    // accepted reading.
    @Volatile
    private var skipNextSpeedCheck: Boolean = false

    /**
     * Reconfigure periodic sampling for the new activity. Also fires an
     * immediate single-shot reading to anchor the transition point.
     */
    fun onActivityChange(newState: ActivityState) {
        currentActivity = newState
        skipNextSpeedCheck = true
        requestSingleReading("activity→${newState.wireName}")
        val tuning = tuningFor(newState)
        if (tuning == null) stopPeriodic() else startPeriodic(tuning)
    }

    fun stop() {
        closed = true
        stopPeriodic()
    }

    private data class Tuning(val intervalMs: Long, val minDistanceM: Float)

    private fun tuningFor(state: ActivityState): Tuning? = when (state) {
        ActivityState.WALKING -> Tuning(intervalMs = 20_000, minDistanceM = 40f)
        ActivityState.RUNNING -> Tuning(intervalMs = 15_000, minDistanceM = 40f)
        ActivityState.ON_BICYCLE -> Tuning(intervalMs = 10_000, minDistanceM = 60f)
        ActivityState.IN_VEHICLE -> Tuning(intervalMs = 10_000, minDistanceM = 100f)
        ActivityState.STILL, ActivityState.UNKNOWN -> null
    }

    @SuppressLint("MissingPermission")
    private fun startPeriodic(tuning: Tuning) {
        if (!hasFineLocationPermission(context)) {
            Log.w(TAG, "FINE location not granted; periodic skipped")
            return
        }
        stopPeriodic()
        val request = LocationRequest.Builder(
            Priority.PRIORITY_HIGH_ACCURACY,
            tuning.intervalMs
        )
            .setMinUpdateDistanceMeters(tuning.minDistanceM)
            .setMinUpdateIntervalMillis(tuning.intervalMs / 2)
            .build()
        try {
            client.requestLocationUpdates(request, periodicCallback, Looper.getMainLooper())
            periodicActive = true
            Log.i(TAG, "periodic started: every ${tuning.intervalMs}ms / ≥${tuning.minDistanceM}m")
        } catch (t: Throwable) {
            Log.w(TAG, "requestLocationUpdates failed", t)
        }
    }

    private fun stopPeriodic() {
        if (!periodicActive) return
        try {
            client.removeLocationUpdates(periodicCallback)
        } catch (t: Throwable) {
            Log.w(TAG, "removeLocationUpdates failed", t)
        }
        periodicActive = false
        Log.i(TAG, "periodic stopped")
    }

    fun requestSingleReading(reason: String) {
        if (!hasFineLocationPermission(context)) {
            Log.w(TAG, "ACCESS_FINE_LOCATION not granted; skip reading ($reason)")
            return
        }

        val request = CurrentLocationRequest.Builder()
            .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
            // Accept cached reading up to 15s old. The previous 60s allowed
            // stale anchors at activity-transition time — you'd "teleport"
            // to where you were a minute ago.
            .setMaxUpdateAgeMillis(15_000L)
            .setDurationMillis(20_000L)     // give up after 20s
            .build()

        Log.i(TAG, "single reading requested: $reason")
        getCurrentLocationSafe(request) { loc ->
            if (loc == null) {
                Log.w(TAG, "location result null for $reason")
                return@getCurrentLocationSafe
            }
            recordReading(loc, reason)
        }
    }

    private fun recordReading(loc: android.location.Location, reason: String) {
        if (closed) return
        val accuracy = loc.accuracy.toDouble()

        // Gate 1 — accuracy. Tightened from 200m → 50m. The previous limit
        // let through optimistic-but-wrong WiFi/cell fixes that the chip
        // stamps with small accuracy radii.
        val limit = if (reason == "start") START_ANCHOR_MAX_ACCURACY_M else MAX_ACCURACY_M
        if (accuracy > limit) {
            Log.i(TAG, "drop accuracy=${accuracy}m > $limit ($reason)")
            return
        }

        // Gate 2 — GPS attestation. PRIORITY_HIGH_ACCURACY is "GPS-led", not
        // "GPS-only" — Fused will happily emit WiFi/cell-triangulated fixes
        // and stamp them with provider="fused". Real GPS fixes set speed
        // and bearing (Doppler shift from satellites gives them for free)
        // and vertical accuracy (only satellites can resolve altitude).
        // WiFi/cell-derived readings set none of these — that's the cleanest
        // signal we have to distinguish the two from a Fused output.
        val gpsAttested = loc.hasVerticalAccuracy() ||
                (loc.hasSpeed() && loc.hasBearing())
        if (!gpsAttested) {
            Log.i(TAG, "drop non-attested provider=${loc.provider} accuracy=${accuracy}m ($reason)")
            return
        }

        // Gate 3 — speed-based outlier rejection. Implied speed from the
        // last accepted reading must be plausible for the current activity
        // state, padded by the combined accuracy budget so a noisy-but-honest
        // fix near the boundary doesn't get kicked. Skipped for the first
        // reading after an activity transition — IN_VEHICLE's first fix is
        // legitimately far from where the phone was sitting still.
        val nowMs = if (loc.time > 0) loc.time else System.currentTimeMillis()
        val last = lastAccepted
        var impliedSpeedMps: Double? = null
        if (last != null && !skipNextSpeedCheck) {
            val dtSec = (nowMs - last.timeMs) / 1000.0
            if (dtSec > 0) {
                val distM = haversineMeters(last.lat, last.lng, loc.latitude, loc.longitude)
                val speed = distM / dtSec
                impliedSpeedMps = speed
                val maxMps = maxSpeedFor(currentActivity)
                val accuracyPad = (last.accuracyM + accuracy) / dtSec
                if (speed > maxMps + accuracyPad) {
                    Log.i(
                        TAG,
                        "drop speed-outlier ${"%.1f".format(speed)}mps > " +
                                "${maxMps}mps + ${"%.1f".format(accuracyPad)}mps pad " +
                                "(${currentActivity.wireName}, $reason)"
                    )
                    return
                }
            }
        }

        // All gates passed — accept.
        skipNextSpeedCheck = false
        lastAccepted = AcceptedReading(
            lat = loc.latitude,
            lng = loc.longitude,
            accuracyM = accuracy,
            timeMs = nowMs
        )

        val provider = loc.provider ?: "fused"
        val data = mutableMapOf<String, Any>(
            "lat" to loc.latitude,
            "lng" to loc.longitude,
            "accuracy_m" to round(accuracy).toInt(),
            "provider" to provider,
            "reason" to reason,
            "gps_attested" to true
        )
        impliedSpeedMps?.let { data["implied_speed_mps"] = round(it * 10.0) / 10.0 }
        scope.launch {
            if (!scope.isActive) return@launch
            emit(
                dao, "phone.location.reading",
                start = Instant.now(),
                durationS = 0.0,
                data = data
            )
        }
    }

    private fun maxSpeedFor(state: ActivityState): Double = when (state) {
        // Anything more than these for the given activity is treated as a
        // GPS jump, not real motion. Generous so genuine readings near the
        // top of a state's range still pass.
        ActivityState.STILL -> 2.0          // sub-walking-pace drift
        ActivityState.WALKING -> 3.5        // brisk walk ≈ 1.7 m/s; 2× headroom
        ActivityState.RUNNING -> 7.0        // fast run ≈ 5 m/s
        ActivityState.ON_BICYCLE -> 14.0    // ~50 km/h
        ActivityState.IN_VEHICLE -> 45.0    // ~160 km/h, freeway worst-case
        ActivityState.UNKNOWN -> 14.0       // treat unknowns conservatively as bike-tier
    }

    private data class AcceptedReading(
        val lat: Double,
        val lng: Double,
        val accuracyM: Double,
        val timeMs: Long
    )

    @SuppressLint("MissingPermission")
    private fun getCurrentLocationSafe(
        request: CurrentLocationRequest,
        onResult: (android.location.Location?) -> Unit
    ) {
        // Permission is checked in the caller. SuppressLint is local.
        // scope.isActive guards against late callbacks firing after the
        // watcher has been unregistered (toggle-off) or the service torn
        // down — without it, the subsequent scope.launch { emit(...) }
        // would throw CancellationException from a stale closure.
        client.getCurrentLocation(request, null)
            .addOnSuccessListener { loc ->
                if (!scope.isActive) {
                    Log.i(TAG, "scope inactive; dropping late success")
                    return@addOnSuccessListener
                }
                onResult(loc)
            }
            .addOnFailureListener { e ->
                if (!scope.isActive) return@addOnFailureListener
                Log.w(TAG, "getCurrentLocation failed", e)
                onResult(null)
            }
    }

    companion object {
        const val TAG = "ScrollantirLocation"
        // Tightened 2026-04-29: 200m was permissive enough to admit
        // WiFi-triangulated jitter on dense-AP areas (campus). Real GPS on
        // Pixel 9 typically reports <30m; 50m gives breathing room without
        // letting the worst stuff through. Combined with the GPS-attested
        // gate in recordReading, very few legitimate fixes get rejected.
        private const val MAX_ACCURACY_M = 50.0
        private const val START_ANCHOR_MAX_ACCURACY_M = 50.0

        /**
         * Great-circle distance in meters between two lat/lng pairs. Used
         * by the speed-outlier filter — Android's `Location.distanceTo` would
         * also work but allocates a result array; this is allocation-free
         * and runs on the main thread occasionally.
         */
        internal fun haversineMeters(
            lat1: Double, lng1: Double,
            lat2: Double, lng2: Double
        ): Double {
            val r = 6_371_000.0
            val dLat = Math.toRadians(lat2 - lat1)
            val dLng = Math.toRadians(lng2 - lng1)
            val a = sin(dLat / 2).let { it * it } +
                    cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
                    sin(dLng / 2).let { it * it }
            val c = 2 * atan2(sqrt(a), sqrt(1 - a))
            return r * c
        }

        fun hasFineLocationPermission(context: Context): Boolean {
            return ContextCompat.checkSelfPermission(
                context, Manifest.permission.ACCESS_FINE_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
        }

        fun hasBackgroundLocationPermission(context: Context): Boolean {
            return ContextCompat.checkSelfPermission(
                context, Manifest.permission.ACCESS_BACKGROUND_LOCATION
            ) == PackageManager.PERMISSION_GRANTED
        }
    }
}
