package app.scrollantir.tracker

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import app.scrollantir.db.AppDatabase
import app.scrollantir.db.EventDao
import app.scrollantir.db.emit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * Detects which view-mode is active inside target apps. Emits sources like
 * `youtube.shorts`, `instagram.reels`, `instagram.stories`, `tiktok.feed`.
 *
 * Detection is only emitted for short-form modes. "Regular YouTube" /
 * "Instagram feed" time is derivable by subtracting the detected mode
 * duration from the total `system.foreground` duration for that package.
 *
 * Detection patterns follow DigiPaws (GPL-3.0, see CREDITS.md): a primary
 * viewId must be present, optionally along with a set of `requiresPresent`
 * corroborating views. The event types we listen to also follow their
 * config — YouTube fires CONTENT_CHANGED, Instagram fires VIEW_SCROLLED.
 */
class ContentDetectorService : AccessibilityService() {

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private lateinit var dao: EventDao

    private data class DetectorRule(
        val source: String,                              // e.g. "youtube.shorts"
        val primaryViewId: String,                       // must be present
        val requiresPresent: List<String> = emptyList(), // all must be present
        val eventTypeMask: Int                           // which event types can trigger detection
    )

    /**
     * Ordered rules per package. First match wins. Default AccessibilityEvent
     * type masks match DigiPaws' ReelAppConfig values.
     */
    private val rulesByPackage: Map<String, List<DetectorRule>> = mapOf(
        ContentDetection.PKG_YOUTUBE to listOf(
            DetectorRule(
                source = "youtube.shorts",
                primaryViewId = "com.google.android.youtube:id/reel_recycler",
                eventTypeMask = AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            )
        ),
        ContentDetection.PKG_YOUTUBE_REVANCED to listOf(
            DetectorRule(
                // Emit under the same source as stock YouTube so downstream
                // queries don't have to handle "YouTube" vs "YouTube Revanced"
                source = "youtube.shorts",
                primaryViewId = "app.revanced.android.youtube:id/reel_recycler",
                eventTypeMask = AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            )
        ),
        ContentDetection.PKG_INSTAGRAM to listOf(
            DetectorRule(
                source = "instagram.reels",
                primaryViewId = "com.instagram.android:id/clips_viewer_view_pager",
                requiresPresent = listOf("com.instagram.android:id/clips_ufi_component"),
                eventTypeMask = AccessibilityEvent.TYPE_VIEW_SCROLLED or
                                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            ),
            DetectorRule(
                source = "instagram.stories",
                primaryViewId = "com.instagram.android:id/reel_viewer_root",
                eventTypeMask = AccessibilityEvent.TYPE_VIEW_SCROLLED or
                                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            )
        ),
        ContentDetection.PKG_TIKTOK to listOf(
            // TikTok is functionally all-feed, all-the-time. Any accessibility
            // event from this package while the service is active = user is in
            // the feed.
            DetectorRule(
                source = "tiktok.feed",
                primaryViewId = "*",  // sentinel — skip viewId check
                eventTypeMask = AccessibilityEvent.TYPES_ALL_MASK
            )
        )
    )

    private data class CurrentMode(val source: String, val startMs: Long)

    @Volatile private var current: CurrentMode? = null
    @Volatile private var lastCheckMs: Long = 0L
    @Volatile private var missCount: Int = 0
    private val lastMissEmitByPkg: MutableMap<String, Long> = mutableMapOf()

    override fun onServiceConnected() {
        super.onServiceConnected()
        dao = AppDatabase.get(applicationContext).events()
        instance = this
        _enabled.value = true
        Log.i(TAG, "onServiceConnected")
    }

    override fun onDestroy() {
        Log.i(TAG, "onDestroy")
        closeCurrentSessionBestEffort()
        instance = null
        _enabled.value = false
        scope.cancel()
        super.onDestroy()
    }

    override fun onInterrupt() {
        Log.w(TAG, "onInterrupt")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return

        // Filter by package BEFORE throttling — we no longer use the XML
        // packageNames filter, so events stream in from every app on the
        // device. Non-target events must return immediately or they'd
        // starve target events through the throttle.
        val rules = rulesByPackage[pkg] ?: return

        val now = System.currentTimeMillis()
        if (now - lastCheckMs < THROTTLE_MS) return
        lastCheckMs = now

        // TikTok short-circuit: any qualifying event = feed active.
        if (pkg == ContentDetection.PKG_TIKTOK) {
            val rule = rules.first()
            if (event.eventType and rule.eventTypeMask == 0) return
            onDetected(rule.source, now)
            return
        }

        val root = rootInActiveWindow
        if (root == null) {
            Log.i(TAG, "rootInActiveWindow=null for $pkg — skipping")
            return
        }

        var matched: String? = null
        for (rule in rules) {
            if (event.eventType and rule.eventTypeMask == 0) continue
            if (!hasNodeId(root, rule.primaryViewId)) continue
            if (rule.requiresPresent.any { !hasNodeId(root, it) }) continue
            matched = rule.source
            break
        }

        if (matched != null) {
            onDetected(matched, now)
        } else {
            Log.i(TAG, "no rule matched for $pkg — emitting detector.miss if cooldown allows")
            onMiss(now)
            maybeEmitMissDiagnostic(pkg, root, now)
        }
    }

    /**
     * When a target app is foreground but no rule matched, emit a
     * `detector.miss` point event once per [MISS_DIAGNOSTIC_COOLDOWN_MS]
     * per package. Carries up to 20 view IDs seen in the tree so we can
     * see what the app actually exposes and update detectors if needed.
     */
    private fun maybeEmitMissDiagnostic(pkg: String, root: AccessibilityNodeInfo, now: Long) {
        val last = lastMissEmitByPkg[pkg] ?: 0L
        if (now - last < MISS_DIAGNOSTIC_COOLDOWN_MS) return
        lastMissEmitByPkg[pkg] = now

        val ids = topLevelViewIds(root, max = 20)
        scope.launch {
            emit(
                dao = dao,
                source = "detector.miss",
                durationS = 0.0,
                data = mapOf("package" to pkg, "view_ids" to ids)
            )
        }
    }

    private fun topLevelViewIds(root: AccessibilityNodeInfo, max: Int): List<String> {
        val out = mutableListOf<String>()
        val queue: ArrayDeque<AccessibilityNodeInfo> = ArrayDeque()
        queue.addLast(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 300 && out.size < max) {
            val n = queue.removeFirst()
            visited++
            val rid = n.viewIdResourceName
            if (!rid.isNullOrBlank()) out.add(rid)
            for (i in 0 until n.childCount) {
                n.getChild(i)?.let { queue.addLast(it) }
            }
        }
        return out
    }

    private fun onDetected(source: String, now: Long) {
        missCount = 0
        val c = current
        if (c != null && c.source == source) return  // same mode, no transition

        c?.let { prev ->
            val durS = (now - prev.startMs) / 1000.0
            scope.launch {
                emit(dao = dao, source = prev.source,
                     start = Instant.ofEpochMilli(prev.startMs), durationS = durS)
            }
            Log.i(TAG, "MODE end:   ${prev.source}  (${"%.1f".format(durS)}s)")
        }
        Log.i(TAG, "MODE start: $source")
        current = CurrentMode(source, now)
    }

    private fun onMiss(now: Long) {
        val c = current ?: return
        missCount++
        if (missCount >= MAX_MISSES_BEFORE_CLOSE) {
            val durS = (now - c.startMs) / 1000.0
            scope.launch {
                emit(dao = dao, source = c.source,
                     start = Instant.ofEpochMilli(c.startMs), durationS = durS)
            }
            Log.i(TAG, "MODE end:   ${c.source}  (${"%.1f".format(durS)}s, ${missCount} misses)")
            current = null
            missCount = 0
        }
    }

    /**
     * Called from UsageStatsPoller when the user leaves a target package.
     * AccessibilityService stops receiving events outside its filter,
     * so this is the only reliable close-signal.
     */
    fun onForegroundLeftTarget() {
        val c = current ?: return
        val now = System.currentTimeMillis()
        val durS = (now - c.startMs) / 1000.0
        scope.launch {
            emit(dao = dao, source = c.source,
                 start = Instant.ofEpochMilli(c.startMs), durationS = durS)
        }
        Log.i(TAG, "MODE end:   ${c.source}  (${"%.1f".format(durS)}s, foreground-left)")
        current = null
        missCount = 0
    }

    private fun closeCurrentSessionBestEffort() {
        val c = current ?: return
        val now = System.currentTimeMillis()
        val durS = (now - c.startMs) / 1000.0
        scope.launch {
            try {
                emit(dao = dao, source = c.source,
                     start = Instant.ofEpochMilli(c.startMs), durationS = durS)
            } catch (_: Throwable) {}
        }
        current = null
    }

    private fun hasNodeId(root: AccessibilityNodeInfo, id: String): Boolean {
        if (id == "*") return true
        val nodes = try {
            root.findAccessibilityNodeInfosByViewId(id)
        } catch (_: Throwable) {
            return false
        } ?: return false
        val found = nodes.isNotEmpty()
        nodes.forEach { it?.recycle() }
        return found
    }

    companion object {
        const val TAG = "ScrollantirDetect"
        private const val THROTTLE_MS = 500L
        private const val MAX_MISSES_BEFORE_CLOSE = 3  // ~1.5s at 500ms throttle
        private const val MISS_DIAGNOSTIC_COOLDOWN_MS = 60_000L  // 1 per minute per pkg

        @Volatile private var instance: ContentDetectorService? = null

        private val _enabled = MutableStateFlow(false)
        val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

        fun notifyForegroundLeft() {
            instance?.onForegroundLeftTarget()
        }
    }
}
