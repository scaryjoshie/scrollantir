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
import kotlin.math.round

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
 * Privacy posture:
 *   - PRIORITY_BALANCED_POWER_ACCURACY (~100m typical, wifi-assisted; not GPS-hot)
 *   - Drop readings with accuracy > 200m (tunnels, indoor with weak signal)
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

    /**
     * Reconfigure periodic sampling for the new activity. Also fires an
     * immediate single-shot reading to anchor the transition point.
     */
    fun onActivityChange(newState: ActivityState) {
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
            Priority.PRIORITY_BALANCED_POWER_ACCURACY,
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
            .setPriority(Priority.PRIORITY_BALANCED_POWER_ACCURACY)
            .setMaxUpdateAgeMillis(60_000L) // accept cached reading up to 1min old
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
        // The "start" anchor fires before GPS has a chance to cold-lock,
        // so Fused falls back to WiFi/cell-tower triangulation which can
        // bias the fix by 100–200m while reporting an optimistic
        // accuracy (<200m). Tightening the gate for the anchor drops
        // those readings; the next periodic/activity-triggered sample
        // backfills seconds later with a real GPS fix.
        val limit = if (reason == "start") START_ANCHOR_MAX_ACCURACY_M else MAX_ACCURACY_M
        if (accuracy > limit) {
            Log.i(TAG, "dropping reading accuracy=${accuracy}m > $limit ($reason)")
            return
        }
        val provider = loc.provider ?: "fused"
        scope.launch {
            if (!scope.isActive) return@launch
            emit(
                dao, "phone.location.reading",
                start = Instant.now(),
                durationS = 0.0,
                data = mapOf(
                    "lat" to loc.latitude,
                    "lng" to loc.longitude,
                    "accuracy_m" to round(accuracy).toInt(),
                    "provider" to provider,
                    "reason" to reason
                )
            )
        }
    }

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
        private const val MAX_ACCURACY_M = 200.0
        private const val START_ANCHOR_MAX_ACCURACY_M = 50.0

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
