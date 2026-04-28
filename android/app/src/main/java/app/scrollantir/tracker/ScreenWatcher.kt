package app.scrollantir.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import android.util.Log
import app.scrollantir.db.EventDao
import app.scrollantir.db.emit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * Listens for screen-on/off and user-present broadcasts.
 *
 * Emits three sources:
 *   system.screen    — duration: one span per continuous screen-on period
 *   system.unlocked  — duration: one span per continuous "user actually using phone" period
 *   system.unlock    — point event: count of unlock actions
 */
class ScreenWatcher(
    private val context: Context,
    private val dao: EventDao,
    private val scope: CoroutineScope
) {

    private var screenOnSince: Instant? = null
    private var unlockedSince: Instant? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            val now = Instant.now()
            when (intent.action) {
                Intent.ACTION_SCREEN_ON -> onScreenOn(now)
                Intent.ACTION_SCREEN_OFF -> onScreenOff(now)
                Intent.ACTION_USER_PRESENT -> onUserPresent(now)
            }
        }
    }

    fun register() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        context.registerReceiver(receiver, filter)

        // Bootstrap from current screen state. Without this, registration
        // while the screen is already on (boot, sideload, restart-after-
        // kill) leaves screenOnSince null until the user does a full
        // power-button cycle — and the next ACTION_SCREEN_OFF gets
        // dropped by the screenOnSince?.let guard. Result: long stretches
        // of foreground/usage with no system.screen rows.
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isInteractive) {
            screenOnSince = Instant.now()
            Log.i(TAG, "SCREEN on (bootstrapped from PowerManager.isInteractive)")
        }

        Log.i(TAG, "registered")
    }

    fun unregister() {
        try {
            context.unregisterReceiver(receiver)
            Log.i(TAG, "unregistered")
        } catch (_: IllegalArgumentException) {
            // Receiver wasn't registered — safe to ignore
        }
    }

    private fun onScreenOn(t: Instant) {
        if (screenOnSince == null) {
            screenOnSince = t
            Log.i(TAG, "SCREEN on")
        }
    }

    private fun onScreenOff(t: Instant) {
        screenOnSince?.let { since ->
            val durS = (t.toEpochMilli() - since.toEpochMilli()) / 1000.0
            Log.i(TAG, "SCREEN off  (${"%.1f".format(durS)}s)")
            scope.launch {
                emit(dao, "system.screen", start = since, durationS = durS,
                     data = mapOf("state" to "on"))
            }
        }
        screenOnSince = null

        unlockedSince?.let { since ->
            val durS = (t.toEpochMilli() - since.toEpochMilli()) / 1000.0
            Log.i(TAG, "UNLOCKED end  (${"%.1f".format(durS)}s)")
            scope.launch {
                emit(dao, "system.unlocked", start = since, durationS = durS)
            }
        }
        unlockedSince = null

        // Close out the in-flight foreground session. Without this, the
        // poller would keep `currentApp` set to whatever was last
        // foregrounded — e.g. Messages at 14:00, screen off at 14:05 — and
        // when the user unlocks two hours later, flushCurrent would emit
        // a bogus 2h+ Messages session.
        //
        // Synchronous: sets a volatile flag that the next pollOnce consumes
        // under the same mutex that processes ACTIVITY_RESUMED events.
        // Guarantees the flush happens BEFORE a post-unlock RESUMED for
        // the same app (which would otherwise be skipped as "already in
        // this app" against stale state).
        UsageStatsPoller.scheduleScreenOffFlush(t.toEpochMilli())
    }

    private fun onUserPresent(t: Instant) {
        Log.i(TAG, "UNLOCK (user present)")
        scope.launch {
            emit(dao, "system.unlock", start = t, durationS = 0.0)
        }
        if (unlockedSince == null) {
            unlockedSince = t
        }
    }

    /**
     * Re-anchor the in-flight screen-on / unlocked spans to [nowMs]
     * without emitting a row. Used by the Settings "Reset local data"
     * flow so that when these spans eventually close they only emit
     * post-reset duration, not pre-wipe time.
     */
    fun resetSpansToNow(nowMs: Long) {
        val t = Instant.ofEpochMilli(nowMs)
        if (screenOnSince != null) screenOnSince = t
        if (unlockedSince != null) unlockedSince = t
    }

    companion object {
        const val TAG = "ScrollantirScreen"
    }
}
