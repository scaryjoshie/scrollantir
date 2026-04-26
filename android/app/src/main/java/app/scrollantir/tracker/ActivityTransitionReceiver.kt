package app.scrollantir.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult

/**
 * Target of the PendingIntent registered by [ActivityWatcher]. Fires on every
 * activity transition emitted by the OS. We filter to ENTER transitions and
 * hand them to [ActivityWatcher.offerTransition], which pushes them onto a
 * SharedFlow collected by the running service.
 *
 * EXIT transitions are dropped — the ENTER of the new state is sufficient to
 * close the previous span.
 */
class ActivityTransitionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return
        val result = ActivityTransitionResult.extractResult(intent) ?: return

        for (event in result.transitionEvents) {
            if (event.transitionType != ActivityTransition.ACTIVITY_TRANSITION_ENTER) continue
            val state = ActivityState.fromDetected(event.activityType)
            // elapsedRealTimeNanos is boot-relative; convert to wall-clock by
            // offsetting against current epoch ms vs current elapsed ns.
            val elapsedMs = event.elapsedRealTimeNanos / 1_000_000L
            val nowMs = System.currentTimeMillis()
            val nowElapsedMs = android.os.SystemClock.elapsedRealtime()
            val atMs = nowMs - (nowElapsedMs - elapsedMs)

            Log.i(TAG, "ENTER ${state.wireName} at $atMs")
            ActivityWatcher.offerTransition(state, atMs)
        }
    }

    companion object {
        const val TAG = "ScrollantirActivityRx"
    }
}
