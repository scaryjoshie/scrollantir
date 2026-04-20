package app.scrollantir.tracker

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.util.Log
import app.scrollantir.db.EventDao
import app.scrollantir.db.emit
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import java.time.Instant
import kotlin.coroutines.coroutineContext

class UsageStatsPoller(
    context: Context,
    private val dao: EventDao
) {

    private val usm: UsageStatsManager =
        context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager

    private var lastQuery: Long = System.currentTimeMillis() - INITIAL_LOOKBACK_MS
    private var currentApp: String? = null
    private var currentStartedAt: Long = 0L

    suspend fun run() {
        Log.i(TAG, "starting (lookback ${INITIAL_LOOKBACK_MS / 1000}s, poll every ${POLL_INTERVAL_MS}ms)")
        while (coroutineContext.isActive) {
            try {
                pollOnce()
            } catch (t: Throwable) {
                Log.e(TAG, "pollOnce failed", t)
            }
            delay(POLL_INTERVAL_MS)
        }
        // Close out any in-flight session on graceful stop
        flushCurrent(System.currentTimeMillis())
        Log.i(TAG, "stopping")
    }

    private suspend fun pollOnce() {
        val now = System.currentTimeMillis()
        val events = usm.queryEvents(lastQuery, now)
        val ev = UsageEvents.Event()

        while (events.getNextEvent(ev)) {
            if (ev.eventType == UsageEvents.Event.ACTIVITY_RESUMED) {
                handleResumed(ev.packageName, ev.timeStamp)
            }
        }

        lastQuery = now
    }

    private suspend fun handleResumed(pkg: String?, t: Long) {
        if (pkg == null || pkg == currentApp) return
        flushCurrent(t)
        Log.i(TAG, "FG start:  $pkg")
        currentApp = pkg
        currentStartedAt = t
    }

    private suspend fun flushCurrent(endMs: Long) {
        val app = currentApp ?: return
        val durMs = (endMs - currentStartedAt).coerceAtLeast(0)
        val durS = durMs / 1000.0
        Log.i(TAG, "FG end:    $app   (${"%.1f".format(durS)}s)")
        emit(
            dao = dao,
            source = "system.foreground",
            start = Instant.ofEpochMilli(currentStartedAt),
            durationS = durS,
            data = mapOf("app" to app)
        )
        currentApp = null
        currentStartedAt = 0L
    }

    companion object {
        const val TAG = "ScrollantirPoll"
        private const val POLL_INTERVAL_MS = 2_500L
        private const val INITIAL_LOOKBACK_MS = 10_000L
    }
}
