package app.scrollantir.tracker

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import app.scrollantir.db.EventDao
import app.scrollantir.db.emit
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.time.Instant

enum class ActivityState(val wireName: String) {
    STILL("still"),
    WALKING("walking"),
    RUNNING("running"),
    ON_BICYCLE("bicycle"),
    IN_VEHICLE("vehicle"),
    UNKNOWN("unknown");

    companion object {
        fun fromDetected(type: Int): ActivityState = when (type) {
            DetectedActivity.STILL -> STILL
            DetectedActivity.WALKING -> WALKING
            DetectedActivity.RUNNING -> RUNNING
            DetectedActivity.ON_BICYCLE -> ON_BICYCLE
            DetectedActivity.IN_VEHICLE -> IN_VEHICLE
            else -> UNKNOWN
        }

        fun fromWireName(name: String?): ActivityState =
            values().firstOrNull { it.wireName == name } ?: UNKNOWN
    }
}

/**
 * Subscribes to ActivityRecognitionClient.requestActivityTransitionUpdates.
 *
 * The OS's sensor fusion tells us when the user transitions between states
 * (STILL → WALKING, WALKING → IN_VEHICLE, etc.). On each ENTER transition we
 * emit a closed duration event for the *previous* state, then update current.
 *
 * The PendingIntent delivers to [ActivityTransitionReceiver], which pushes
 * events onto [transitions] for us to consume here under the service's scope.
 */
class ActivityWatcher(
    private val context: Context,
    private val dao: EventDao,
    private val scope: CoroutineScope,
    private val onStateChange: (ActivityState) -> Unit
) {
    @Volatile
    var current: ActivityState = ActivityState.UNKNOWN
        private set

    private var currentStartedAt: Instant = Instant.now()
    private var pendingIntent: PendingIntent? = null
    private var collectorJob: Job? = null

    fun register() {
        if (!hasActivityRecognitionPermission(context)) {
            Log.w(TAG, "ACTIVITY_RECOGNITION not granted; skipping register")
            return
        }

        val intent = Intent(context, ActivityTransitionReceiver::class.java)
            .setAction(ACTION_TRANSITION)
        val pi = PendingIntent.getBroadcast(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )
        pendingIntent = pi

        val transitions = buildList<ActivityTransition> {
            for (type in TRACKED_ACTIVITIES) {
                add(buildTransition(type, ActivityTransition.ACTIVITY_TRANSITION_ENTER))
                add(buildTransition(type, ActivityTransition.ACTIVITY_TRANSITION_EXIT))
            }
        }
        val request = ActivityTransitionRequest(transitions)

        val client = ActivityRecognition.getClient(context)
        client.requestActivityTransitionUpdates(request, pi)
            .addOnSuccessListener { Log.i(TAG, "activity transition subscription registered") }
            .addOnFailureListener { e -> Log.e(TAG, "failed to register activity transitions", e) }

        // Collect incoming transitions under the service scope. Kept as a
        // named Job so unregister() can cancel it — otherwise a second
        // register() after a toggle-OFF/ON cycle leaves two live collectors
        // both consuming from the shared flow, emitting duplicate rows and
        // driving the old (already-dropped) LocationWatcher via closure
        // capture.
        collectorJob = scope.launch {
            transitionsFlow.collect { event ->
                handleEnter(event.state, event.atMs)
            }
        }

        // Seed "current started at = now". We won't emit for the initial
        // UNKNOWN span — see handleEnter.
        currentStartedAt = Instant.now()
    }

    fun unregister() {
        pendingIntent?.let { pi ->
            try {
                ActivityRecognition.getClient(context)
                    .removeActivityTransitionUpdates(pi)
            } catch (t: Throwable) {
                Log.w(TAG, "removeActivityTransitionUpdates failed", t)
            }
        }
        pendingIntent = null
        collectorJob?.cancel()
        collectorJob = null
        _inFlight.value = null
    }

    /**
     * Re-anchor the in-flight span's start time to [nowMs] without closing
     * it or emitting a row. Used by the Settings "Reset local data" flow:
     * the DB is wiped, but the in-memory span continues — we just make
     * sure that when it eventually closes, it only emits post-reset time.
     */
    fun resetSpanToNow(nowMs: Long) {
        currentStartedAt = Instant.ofEpochMilli(nowMs)
        val c = current
        _inFlight.value = if (c == ActivityState.UNKNOWN) null else InFlight(c, nowMs)
    }

    /**
     * Flush the in-flight current-state span. Called from service onDestroy
     * under runBlocking+NonCancellable, same pattern as UsageStatsPoller.
     */
    fun flushCurrent(nowMs: Long) {
        val prev = current
        val startedAt = currentStartedAt
        if (prev == ActivityState.UNKNOWN) return
        val endInstant = Instant.ofEpochMilli(nowMs)
        val durS = (endInstant.toEpochMilli() - startedAt.toEpochMilli()) / 1000.0
        if (durS <= 0) return
        runBlocking(Dispatchers.IO + NonCancellable) {
            emit(
                dao, "phone.activity.state",
                start = startedAt, durationS = durS,
                data = mapOf("state" to prev.wireName)
            )
        }
    }

    private suspend fun handleEnter(newState: ActivityState, atMs: Long) {
        val at = Instant.ofEpochMilli(atMs)
        val prev = current
        val startedAt = currentStartedAt

        if (newState == prev) {
            // Observed occasionally when the OS classifier is flapping
            // between confidence bands. The span-close model only fires on
            // genuine state changes, so a duplicate ENTER is harmless but
            // worth flagging for post-hoc sanity checks.
            Log.w(TAG, "duplicate ENTER for ${newState.wireName} — ignored")
            return
        }

        // Emit the previous span. Skip the seed UNKNOWN so we don't litter
        // the timeline with a "unknown from service-start" row.
        if (prev != ActivityState.UNKNOWN) {
            val durS = (at.toEpochMilli() - startedAt.toEpochMilli()) / 1000.0
            if (durS > 0) {
                emit(
                    dao, "phone.activity.state",
                    start = startedAt, durationS = durS,
                    data = mapOf("state" to prev.wireName)
                )
            }
        }

        current = newState
        currentStartedAt = at
        _inFlight.value = InFlight(newState, at.toEpochMilli())
        Log.i(TAG, "activity → ${newState.wireName} at $at")
        onStateChange(newState)
    }

    private fun buildTransition(activityType: Int, transitionType: Int): ActivityTransition {
        val builder = ActivityTransition.Builder()
        builder.setActivityType(activityType)
        builder.setActivityTransition(transitionType)
        return builder.build()
    }

    companion object {
        const val TAG = "ScrollantirActivity"
        const val ACTION_TRANSITION = "app.scrollantir.ACTION_ACTIVITY_TRANSITION"

        private val TRACKED_ACTIVITIES = listOf(
            DetectedActivity.STILL,
            DetectedActivity.WALKING,
            DetectedActivity.RUNNING,
            DetectedActivity.ON_BICYCLE,
            DetectedActivity.IN_VEHICLE,
        )

        data class Incoming(val state: ActivityState, val atMs: Long)

        private val _transitions = MutableSharedFlow<Incoming>(extraBufferCapacity = 32)
        private val transitionsFlow = _transitions.asSharedFlow()

        /**
         * Currently-active activity span, surfaced as state so the
         * LocationScreen can render an "in-flight" row (e.g., "Still · 9am
         * → now (1h 15m)"). Null when no watcher is registered or the seed
         * UNKNOWN hasn't cleared yet.
         */
        data class InFlight(val state: ActivityState, val startedAtMs: Long)

        private val _inFlight = MutableStateFlow<InFlight?>(null)
        val inFlight: StateFlow<InFlight?> = _inFlight.asStateFlow()

        /**
         * Called from [ActivityTransitionReceiver.onReceive] with ENTER-type
         * events extracted from the broadcast. Delivers to the service's
         * collector if one is alive; otherwise events drop (service down =
         * location tracking off).
         */
        fun offerTransition(state: ActivityState, atMs: Long) {
            _transitions.tryEmit(Incoming(state, atMs))
        }

        fun hasActivityRecognitionPermission(context: Context): Boolean {
            return ContextCompat.checkSelfPermission(
                context, Manifest.permission.ACTIVITY_RECOGNITION
            ) == PackageManager.PERMISSION_GRANTED
        }
    }
}
