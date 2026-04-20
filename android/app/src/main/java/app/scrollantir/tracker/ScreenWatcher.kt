package app.scrollantir.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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

    companion object {
        const val TAG = "ScrollantirScreen"
    }
}
