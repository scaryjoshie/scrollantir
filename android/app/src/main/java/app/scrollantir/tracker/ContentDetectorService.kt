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
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
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
        // Any-of: rule matches if ANY of these viewIds is present in the
        // tree. Add fallbacks here so a single ID rename in a minor app
        // update doesn't silently break detection.
        val primaryViewIds: List<String>,
        // All-of corroborators (rare). Prefer making `primaryViewIds`
        // sufficiently specific instead — every entry here is one more
        // way the rule can silently break on app updates.
        val requiresPresent: List<String> = emptyList(),
        val eventTypeMask: Int                           // which event types can trigger detection
    )

    /**
     * Ordered rules per package. First match wins. Default AccessibilityEvent
     * type masks match DigiPaws' ReelAppConfig values.
     *
     * Robustness note: each rule lists multiple acceptable `primaryViewIds`.
     * As of 2026-04, YouTube/Revanced removed `reel_recycler` from the
     * Shorts top-of-tree (visible in detector.miss event tail) — `reel_time_bar`
     * (Shorts progress bar) is the new most-reliable signal. Keeping the
     * historical IDs in the list means we still match on older app versions.
     */
    private val rulesByPackage: Map<String, List<DetectorRule>> = mapOf(
        ContentDetection.PKG_YOUTUBE to listOf(
            DetectorRule(
                source = "youtube.shorts",
                primaryViewIds = listOf(
                    // Shorts-only progress bar (most reliable post-2026-04).
                    "com.google.android.youtube:id/reel_time_bar",
                    // Historical IDs — keep as fallbacks for older builds.
                    "com.google.android.youtube:id/reel_recycler",
                    "com.google.android.youtube:id/reel_player_underlay",
                    "com.google.android.youtube:id/reel_player_overlay"
                ),
                eventTypeMask = AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            )
        ),
        ContentDetection.PKG_YOUTUBE_REVANCED to listOf(
            DetectorRule(
                // Emit under the same source as stock YouTube so downstream
                // queries don't have to handle "YouTube" vs "YouTube Revanced"
                source = "youtube.shorts",
                primaryViewIds = listOf(
                    "app.revanced.android.youtube:id/reel_time_bar",
                    "app.revanced.android.youtube:id/reel_recycler",
                    "app.revanced.android.youtube:id/reel_player_underlay",
                    "app.revanced.android.youtube:id/reel_player_overlay"
                ),
                eventTypeMask = AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            )
        ),
        ContentDetection.PKG_INSTAGRAM to listOf(
            // Reels rule — `clips_viewer_*` IDs are already Reels-specific
            // (only present inside the Reels tab/player), so we drop the
            // `clips_ufi_component` corroborator that was silently breaking
            // detection whenever IG renamed the UFI overlay.
            DetectorRule(
                source = "instagram.reels",
                primaryViewIds = listOf(
                    "com.instagram.android:id/clips_viewer_view_pager",
                    "com.instagram.android:id/clips_viewer_recyclerview",
                    "com.instagram.android:id/clips_viewer_layout",
                    "com.instagram.android:id/clips_video_container"
                ),
                eventTypeMask = AccessibilityEvent.TYPE_VIEW_SCROLLED or
                                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
            ),
            DetectorRule(
                source = "instagram.stories",
                primaryViewIds = listOf(
                    "com.instagram.android:id/reel_viewer_root",
                    "com.instagram.android:id/reel_viewer_media_layout",
                    "com.instagram.android:id/reel_viewer_content_layout"
                ),
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
                primaryViewIds = listOf("*"),  // sentinel — skip viewId check
                eventTypeMask = AccessibilityEvent.TYPES_ALL_MASK
            )
        )
    )

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
        // Track which rule got partway through (primary matched but
        // a `requiresPresent` corroborator failed) so the miss
        // diagnostic can call out the exact ID that drifted.
        var nearMissSource: String? = null
        var nearMissAbsentCorroborators: List<String> = emptyList()
        for (rule in rules) {
            if (event.eventType and rule.eventTypeMask == 0) continue
            val primaryMatched = rule.primaryViewIds.any { hasNodeId(root, it) }
            if (!primaryMatched) continue
            val absent = rule.requiresPresent.filter { !hasNodeId(root, it) }
            if (absent.isNotEmpty()) {
                nearMissSource = rule.source
                nearMissAbsentCorroborators = absent
                continue
            }
            matched = rule.source
            break
        }

        if (matched != null) {
            onDetected(matched, now)
        } else {
            Log.i(TAG, "no rule matched for $pkg — emitting detector.miss if cooldown allows")
            onMiss(now)
            maybeEmitMissDiagnostic(pkg, root, now, nearMissSource, nearMissAbsentCorroborators)
        }
    }

    /**
     * When a target app is foreground but no rule matched, emit a
     * `detector.miss` point event once per [MISS_DIAGNOSTIC_COOLDOWN_MS]
     * per package. Carries up to 40 view IDs seen in the tree, plus —
     * if a rule's primary matched but its `requiresPresent` corroborators
     * failed — which corroborators were missing. That makes future ID
     * drift trivially debuggable: detector.miss tells you exactly which
     * ID disappeared instead of just dumping a tree fragment.
     *
     * Rule presence-checks: for each registered rule on this package,
     * record which of the rule's primaryViewIds was found (if any) and
     * which were absent. Lets us see "Reels rule failed because none of
     * [pager, recyclerview, layout] were present" at a glance.
     */
    private fun maybeEmitMissDiagnostic(
        pkg: String,
        root: AccessibilityNodeInfo,
        now: Long,
        nearMissSource: String?,
        nearMissAbsentCorroborators: List<String>
    ) {
        val last = lastMissEmitByPkg[pkg] ?: 0L
        if (now - last < MISS_DIAGNOSTIC_COOLDOWN_MS) return
        lastMissEmitByPkg[pkg] = now

        val ids = topLevelViewIds(root, max = 40)
        val rules = rulesByPackage[pkg].orEmpty()
        // Per-rule presence breakdown: which primary IDs were searched
        // for, which were found. Stored as a list of maps so it serialises
        // cleanly through the existing JSON event pipeline.
        val rulePresence: List<Map<String, Any>> = rules.map { rule ->
            val present = rule.primaryViewIds.filter { it != "*" && hasNodeId(root, it) }
            val absent = rule.primaryViewIds.filter { it != "*" && !hasNodeId(root, it) }
            mapOf(
                "source" to rule.source,
                "primary_present" to present,
                "primary_absent" to absent
            )
        }
        val data = mutableMapOf<String, Any>(
            "package" to pkg,
            "view_ids" to ids,
            "rule_presence" to rulePresence
        )
        if (nearMissSource != null) {
            data["near_miss_source"] = nearMissSource
            data["near_miss_absent_corroborators"] = nearMissAbsentCorroborators
        }
        scope.launch {
            emit(
                dao = dao,
                source = "detector.miss",
                durationS = 0.0,
                data = data
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
        val cm = CurrentMode(source, now)
        current = cm
        _currentMode.value = cm
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
            _currentMode.value = null
            missCount = 0
        }
    }

    /**
     * Called from UsageStatsPoller when the user leaves a target package.
     * AccessibilityService stops receiving events outside its filter,
     * so this is the only reliable close-signal.
     *
     * [endMs] is the timestamp the poller observed the app-leave at —
     * more accurate than System.currentTimeMillis() here because the
     * poller is up to [POLL_INTERVAL_MS] older than "now".
     */
    fun onForegroundLeftTarget(endMs: Long) {
        val c = current ?: return
        val durS = (endMs - c.startMs).coerceAtLeast(0) / 1000.0
        scope.launch {
            emit(dao = dao, source = c.source,
                 start = Instant.ofEpochMilli(c.startMs), durationS = durS)
        }
        Log.i(TAG, "MODE end:   ${c.source}  (${"%.1f".format(durS)}s, foreground-left)")
        current = null
        _currentMode.value = null
        missCount = 0
    }

    private fun closeCurrentSessionBestEffort() {
        // Called from onDestroy, immediately before scope.cancel(). The
        // previous implementation scheduled the final emit via scope.launch,
        // which got canceled before the DB write ran. runBlocking with
        // NonCancellable + IO dispatcher is the same shape used in
        // TrackerForegroundService.onDestroy for the poller flush — the
        // emit completes synchronously even though teardown is in flight.
        val c = current ?: return
        val now = System.currentTimeMillis()
        val durS = (now - c.startMs) / 1000.0
        try {
            runBlocking(Dispatchers.IO + NonCancellable) {
                emit(dao = dao, source = c.source,
                     start = Instant.ofEpochMilli(c.startMs), durationS = durS)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "closeCurrentSessionBestEffort emit failed", t)
        }
        current = null
        _currentMode.value = null
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

    data class CurrentMode(val source: String, val startMs: Long)

    companion object {
        const val TAG = "ScrollantirDetect"
        private const val THROTTLE_MS = 500L
        private const val MAX_MISSES_BEFORE_CLOSE = 3  // ~1.5s at 500ms throttle
        private const val MISS_DIAGNOSTIC_COOLDOWN_MS = 60_000L  // 1 per minute per pkg

        @Volatile private var instance: ContentDetectorService? = null

        private val _enabled = MutableStateFlow(false)
        val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

        /** Live in-flight mode (youtube.shorts / instagram.reels / etc.) for
         *  the Today dashboard to fold into its totals — otherwise a mode
         *  that's been active for the last 20 minutes wouldn't count until
         *  the user left the app. */
        private val _currentMode = MutableStateFlow<CurrentMode?>(null)
        val currentMode: StateFlow<CurrentMode?> = _currentMode.asStateFlow()

        fun notifyForegroundLeft(endMs: Long) {
            instance?.onForegroundLeftTarget(endMs)
        }

        /**
         * Re-anchor the in-flight content-mode span to [nowMs] without
         * emitting. For the Settings "Reset local data" flow — see the
         * corresponding methods on UsageStatsPoller, ActivityWatcher,
         * and ScreenWatcher.
         */
        fun resetSpanToNow(nowMs: Long) {
            val inst = instance ?: return
            val c = inst.current ?: return
            inst.current = CurrentMode(c.source, nowMs)
            _currentMode.value = CurrentMode(c.source, nowMs)
        }
    }
}
