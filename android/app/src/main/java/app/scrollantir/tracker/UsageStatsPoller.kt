package app.scrollantir.tracker

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
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
    private val pm: PackageManager = context.packageManager
    // Memoized package → human-readable label. PackageManager calls are
    // cheap individually but we'd call tens of thousands per day without
    // caching. Keyed by packageName; value of null means "lookup failed".
    private val labelCache = java.util.concurrent.ConcurrentHashMap<String, String>()

    private fun labelFor(pkg: String): String = labelCache.getOrPut(pkg) {
        try {
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        } catch (_: PackageManager.NameNotFoundException) {
            pkg
        } catch (_: Throwable) {
            pkg
        }
    }

    // Mutex serializes pollOnce (processes UsageEvents) and flushCurrent
    // (external caller). All writes to currentApp / currentStartedAt /
    // lastQuery happen under this lock.
    private val mutex = Mutex()
    private var lastQuery: Long = System.currentTimeMillis() - INITIAL_LOOKBACK_MS
    private var currentApp: String? = null
    private var currentStartedAt: Long = 0L

    // Set synchronously by ScreenWatcher on SCREEN_OFF. The next pollOnce
    // processes this under the mutex BEFORE reading new UsageEvents — this
    // ensures the flush happens before any ACTIVITY_RESUMED for the same
    // app (user unlocking back to the same app) is observed and skipped
    // because the state still said "already in this app."
    @Volatile private var pendingScreenOffFlushMs: Long? = null

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
            flushCurrent(System.currentTimeMillis())
        } finally {
            activeInstance = null
            Log.i(TAG, "stopping")
        }
    }

    private suspend fun pollOnce() {
        mutex.withLock {
            // If a screen-off flush was scheduled since the last poll,
            // process it FIRST and rewind lastQuery to the screen-off
            // moment. That way any RESUMED event that fired between
            // screen-off and now gets seen against a freshly-null
            // currentApp and starts a new session correctly — instead of
            // being skipped because currentApp still equalled the app
            // the user was in before locking.
            val pending = pendingScreenOffFlushMs
            if (pending != null) {
                flushCurrentLocked(pending)
                lastQuery = pending
                pendingScreenOffFlushMs = null
            }

            val now = System.currentTimeMillis()
            val events = usm.queryEvents(lastQuery, now)
            val ev = UsageEvents.Event()
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
     * Synchronous flush — for service onDestroy via runBlocking. Mutex
     * guarded, safe from any coroutine.
     */
    internal suspend fun flushCurrent(endMs: Long) {
        mutex.withLock { flushCurrentLocked(endMs) }
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
            // `app` = stable package identifier (never changes across renames,
            // primary key for downstream joins). `app_label` = presentation-
            // layer human name from PackageManager; used by server logs and
            // any UI that doesn't have its own AppIconCache.
            data = mapOf(
                "app" to app,
                "app_label" to labelFor(app)
            )
        )
        if (app in ContentDetection.TARGET_PACKAGES) {
            ContentDetectorService.notifyForegroundLeft(endMs)
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

        private val _currentForeground = MutableStateFlow<CurrentForeground?>(null)
        val currentForeground: StateFlow<CurrentForeground?> = _currentForeground.asStateFlow()

        @Volatile private var activeInstance: UsageStatsPoller? = null

        /**
         * Schedule a flush-at-[endMs] that runs at the start of the next
         * pollOnce under the mutex. Returns immediately — no coroutine, no
         * blocking. Safe to call from any thread (synchronous writes to
         * volatile Long).
         */
        fun scheduleScreenOffFlush(endMs: Long) {
            activeInstance?.pendingScreenOffFlushMs = endMs
        }

        /** Suspend flush — for service onDestroy via runBlocking. */
        suspend fun flushActiveSession(atMs: Long = System.currentTimeMillis()) {
            activeInstance?.flushCurrent(atMs)
        }
    }
}
