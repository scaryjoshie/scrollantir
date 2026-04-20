package app.scrollantir.tracker

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.util.Log
import app.scrollantir.db.EventDao
import app.scrollantir.db.emit
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import kotlin.coroutines.coroutineContext

class UsageStatsPoller(
    context: Context,
    private val dao: EventDao
) {

    private val usm: UsageStatsManager =
        context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager

    // Mutex guards currentApp / currentStartedAt so external callers
    // (ScreenWatcher on SCREEN_OFF, service onDestroy) can safely flush
    // without racing the poll loop.
    private val mutex = Mutex()
    private var lastQuery: Long = System.currentTimeMillis() - INITIAL_LOOKBACK_MS
    private var currentApp: String? = null
    private var currentStartedAt: Long = 0L

    suspend fun run() {
        Log.i(TAG, "starting (lookback ${INITIAL_LOOKBACK_MS / 1000}s, poll every ${POLL_INTERVAL_MS}ms)")
        activeInstance = this
        try {
            while (coroutineContext.isActive) {
                try {
                    pollOnce()
                } catch (t: Throwable) {
                    Log.e(TAG, "pollOnce failed", t)
                }
                delay(POLL_INTERVAL_MS)
            }
            // Graceful stop
            flushCurrent(System.currentTimeMillis())
        } finally {
            activeInstance = null
            Log.i(TAG, "stopping")
        }
    }

    private suspend fun pollOnce() {
        val now = System.currentTimeMillis()
        val events = usm.queryEvents(lastQuery, now)
        val ev = UsageEvents.Event()

        mutex.withLock {
            while (events.getNextEvent(ev)) {
                if (ev.eventType == UsageEvents.Event.ACTIVITY_RESUMED) {
                    handleResumedLocked(ev.packageName, ev.timeStamp)
                }
            }
            lastQuery = now
        }
    }

    /** Must be called with [mutex] held. */
    private suspend fun handleResumedLocked(pkg: String?, t: Long) {
        if (pkg == null || pkg == currentApp) return
        flushCurrentLocked(t)
        Log.i(TAG, "FG start:  $pkg")
        currentApp = pkg
        currentStartedAt = t
        _currentForeground.value = CurrentForeground(pkg, t)
    }

    /**
     * Close out the in-flight foreground session, if any. Safe to call
     * from any coroutine — mutex-guarded.
     */
    internal suspend fun flushCurrent(endMs: Long) {
        mutex.withLock {
            flushCurrentLocked(endMs)
        }
    }

    /** Must be called with [mutex] held. */
    private suspend fun flushCurrentLocked(endMs: Long) {
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
        if (app in ContentDetection.TARGET_PACKAGES) {
            ContentDetectorService.notifyForegroundLeft()
        }
        currentApp = null
        currentStartedAt = 0L
        _currentForeground.value = null
    }

    data class CurrentForeground(val pkg: String, val startedAtMs: Long)

    companion object {
        const val TAG = "ScrollantirPoll"
        private const val POLL_INTERVAL_MS = 2_500L
        private const val INITIAL_LOOKBACK_MS = 10_000L

        /** Live "what's foregrounded right now" for the Today dashboard. */
        private val _currentForeground = MutableStateFlow<CurrentForeground?>(null)
        val currentForeground: StateFlow<CurrentForeground?> = _currentForeground.asStateFlow()

        /**
         * Pointer to the poller currently running inside the foreground
         * service, or null if none. Set in run(), cleared on return.
         * Exposed so ScreenWatcher can signal session-close on screen-off
         * without plumbing a direct reference through.
         */
        @Volatile private var activeInstance: UsageStatsPoller? = null

        /** Flush the active poller's in-flight session, if any. */
        suspend fun flushActiveSession(atMs: Long = System.currentTimeMillis()) {
            activeInstance?.flushCurrent(atMs)
        }
    }
}
