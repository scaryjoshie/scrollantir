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

    // Fallback flag set synchronously by ScreenWatcher on ACTION_SCREEN_OFF.
    // Primary source-of-truth for screen-off is now the SCREEN_NON_INTERACTIVE
    // events surfaced by UsageStatsManager itself (handled inline by
    // pollOnce below), which carries the authoritative timestamp, survives
    // doze, and can enumerate multiple screen-offs that happened while the
    // poller coroutine was frozen. The broadcast flag only covers the
    // latency gap between the OS screen-off broadcast and UsageStatsManager
    // recording the matching SCREEN_NON_INTERACTIVE event (a few seconds
    // on most builds).
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
            // Walk the UsageStatsManager event stream in chronological
            // order, flushing at each screen-off and starting new sessions
            // at each ACTIVITY_RESUMED. Doing this in-stream — instead of
            // driving flush purely off the ScreenWatcher broadcast — is
            // what makes overnight-doze correct: when the poller coroutine
            // finally wakes up in the morning, the stream contains every
            // screen-off that fired while it was frozen, each with its
            // own timestamp, so multi-screen-off sequences produce the
            // right series of sessions instead of one bogus span across
            // the whole sleep period.
            val now = System.currentTimeMillis()
            val events = usm.queryEvents(lastQuery, now)
            val ev = UsageEvents.Event()
            while (events.getNextEvent(ev)) {
                when (ev.eventType) {
                    UsageEvents.Event.ACTIVITY_RESUMED ->
                        handleResumedLocked(ev.packageName, ev.timeStamp)
                    UsageEvents.Event.SCREEN_NON_INTERACTIVE ->
                        flushCurrentLocked(ev.timeStamp)
                }
            }
            // Fast-path fallback for the latency gap: if the broadcast
            // flag is set and the stream above didn't already close the
            // session (currentApp would be null in that case), close it
            // at the broadcast time. The currentStartedAt guard prevents
            // a stale flag from retroactively flushing a newer session.
            pendingScreenOffFlushMs?.let { pending ->
                if (currentApp != null && pending >= currentStartedAt) {
                    flushCurrentLocked(pending)
                }
                pendingScreenOffFlushMs = null
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

        /**
         * Re-anchor the in-flight foreground session to [nowMs] without
         * closing or emitting. For the Settings "Reset local data" flow:
         * after wiping the events table, anything still held in memory
         * would emit a pre-wipe start time when it eventually closes, so
         * we just pretend the current app started now.
         */
        fun resetSpanToNow(nowMs: Long) {
            val inst = activeInstance ?: return
            if (inst.currentApp == null) return
            inst.currentStartedAt = nowMs
            _currentForeground.value = CurrentForeground(inst.currentApp!!, nowMs)
        }
    }
}
