package app.scrollantir.tracker

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import android.util.Log
import app.scrollantir.db.EventDao
import app.scrollantir.db.emit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
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

        // Bootstrap from current OS state. Without this, registration
        // while screen is on / device unlocked (boot, sideload, restart-
        // after-kill) leaves screenOnSince/unlockedSince null until the
        // user does a full off→on cycle — and the next ACTION_SCREEN_OFF
        // gets dropped by the screenOnSince?.let guard. Result: long
        // stretches of foreground/usage with no system.screen rows and
        // unlocked spans that never get sealed.
        //
        // The bootstrapped unlocked span starts at register-time, not the
        // real (unknown) unlock instant — slightly imprecise on the first
        // post-restart span, but better than dropping it entirely. No
        // synthetic system.unlock POINT event is emitted (we don't know
        // when unlock actually happened), so the first bootstrapped
        // unlocked span has no paired unlock point. Subsequent spans are
        // accurate.
        val now = Instant.now()
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isInteractive) {
            screenOnSince = now
            Log.i(TAG, "SCREEN on (bootstrapped from PowerManager.isInteractive)")
            val km = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            if (!km.isDeviceLocked) {
                unlockedSince = now
                Log.i(TAG, "UNLOCKED (bootstrapped from KeyguardManager.isDeviceLocked=false)")
            }
        }

        Log.i(TAG, "registered")
    }

    fun unregister() {
        // Seal any in-flight spans BEFORE removing the receiver, so service
        // teardown doesn't drop them silently. Same shape as the poller
        // flush in TrackerForegroundService.onDestroy: runBlocking on the
        // IO dispatcher with NonCancellable so the DB write completes even
        // if the caller's scope is being canceled.
        flushOpenSpansBlocking(Instant.now())
        try {
            context.unregisterReceiver(receiver)
            Log.i(TAG, "unregistered")
        } catch (_: IllegalArgumentException) {
            // Receiver wasn't registered — safe to ignore
        }
    }

    private fun flushOpenSpansBlocking(t: Instant) {
        val screenSince = screenOnSince
        val unlockedAt = unlockedSince
        if (screenSince == null && unlockedAt == null) return
        try {
            runBlocking(Dispatchers.IO + NonCancellable) {
                if (screenSince != null) {
                    val durS = (t.toEpochMilli() - screenSince.toEpochMilli()) / 1000.0
                    Log.i(TAG, "SCREEN seal on unregister  (${"%.1f".format(durS)}s)")
                    emit(dao, "system.screen", start = screenSince, durationS = durS,
                         data = mapOf("state" to "on"))
                }
                if (unlockedAt != null) {
                    val durS = (t.toEpochMilli() - unlockedAt.toEpochMilli()) / 1000.0
                    Log.i(TAG, "UNLOCKED seal on unregister  (${"%.1f".format(durS)}s)")
                    emit(dao, "system.unlocked", start = unlockedAt, durationS = durS)
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "flushOpenSpansBlocking failed", t)
        }
        screenOnSince = null
        unlockedSince = null
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
        // Idempotent on duplicate USER_PRESENT broadcasts (some Android
        // versions / OEM builds fire it twice on a single unlock).
        // Without this guard we'd emit two unlock POINT events for one
        // unlocked span, which is the 5-vs-4 unlock/unlocked mismatch
        // observed in live data.
        if (unlockedSince != null) return
        Log.i(TAG, "UNLOCK (user present)")
        scope.launch {
            emit(dao, "system.unlock", start = t, durationS = 0.0)
        }
        unlockedSince = t
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
