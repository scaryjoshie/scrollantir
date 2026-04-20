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
 * Detects which view-mode is showing within YouTube, Instagram, and TikTok,
 * and emits sources like `youtube.shorts`, `instagram.reels`, etc.
 *
 * Session lifecycle:
 *  - A detected mode opens a session (stored in memory as [current])
 *  - The session closes when:
 *      (a) a different mode is detected in the same app
 *      (b) [onForegroundLeftTarget] is called by UsageStatsPoller after
 *          the user leaves a target app (Android stops delivering events
 *          to this service once the foreground app is outside the filter)
 *
 * Detection heuristics are based on DigiPaws' published detector patterns
 * (see CREDITS.md). Resource IDs drift across app redesigns; `detector.miss`
 * diagnostic events are emitted whenever a target app is on-screen but no
 * rule matches, so we can spot regressions and update detectors.
 */
class ContentDetectorService : AccessibilityService() {

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private lateinit var dao: EventDao

    private data class CurrentMode(val source: String, val startMs: Long)

    @Volatile private var current: CurrentMode? = null
    @Volatile private var lastCheckMs: Long = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        dao = AppDatabase.get(applicationContext).events()
        instance = this
        _enabled.value = true
        Log.i(TAG, "onServiceConnected")
    }

    override fun onDestroy() {
        Log.i(TAG, "onDestroy")
        // Close out any in-flight mode before we go away
        closeCurrentSessionBlocking()
        instance = null
        _enabled.value = false
        scope.cancel()
        super.onDestroy()
    }

    override fun onInterrupt() {
        Log.w(TAG, "onInterrupt")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val now = System.currentTimeMillis()
        if (now - lastCheckMs < THROTTLE_MS) return
        lastCheckMs = now

        val pkg = event.packageName?.toString() ?: return
        if (pkg !in ContentDetection.TARGET_PACKAGES) return

        val root = rootInActiveWindow ?: return

        val detected = when (pkg) {
            ContentDetection.PKG_YOUTUBE -> detectYouTube(root)
            ContentDetection.PKG_INSTAGRAM -> detectInstagram(root)
            ContentDetection.PKG_TIKTOK -> "tiktok.feed"
            else -> null
        }

        if (detected == null) {
            // Target app is foreground but no rule matched — diagnostic
            val ids = topLevelViewIds(root, max = 20)
            scope.launch {
                emit(
                    dao = dao,
                    source = "detector.miss",
                    durationS = 0.0,
                    data = mapOf(
                        "package" to pkg,
                        "view_ids" to ids
                    )
                )
            }
            return
        }

        val c = current
        if (c != null && c.source == detected) return  // still in same mode

        // Transition: close previous, open new
        c?.let { prev ->
            val durS = (now - prev.startMs) / 1000.0
            scope.launch {
                emit(
                    dao = dao,
                    source = prev.source,
                    start = Instant.ofEpochMilli(prev.startMs),
                    durationS = durS
                )
            }
            Log.i(TAG, "MODE end:   ${prev.source}  (${"%.1f".format(durS)}s)")
        }
        Log.i(TAG, "MODE start: $detected")
        current = CurrentMode(detected, now)
    }

    /**
     * Called by UsageStatsPoller when the foreground app leaves a target
     * package. AccessibilityService doesn't get background events, so this
     * is the only way to close a session cleanly.
     */
    fun onForegroundLeftTarget() {
        val c = current ?: return
        val now = System.currentTimeMillis()
        val durS = (now - c.startMs) / 1000.0
        scope.launch {
            emit(
                dao = dao,
                source = c.source,
                start = Instant.ofEpochMilli(c.startMs),
                durationS = durS
            )
        }
        Log.i(TAG, "MODE end:   ${c.source}  (${"%.1f".format(durS)}s, foreground-left)")
        current = null
    }

    private fun closeCurrentSessionBlocking() {
        // Called from onDestroy — scope may be about to cancel. Best effort.
        val c = current ?: return
        val now = System.currentTimeMillis()
        val durS = (now - c.startMs) / 1000.0
        scope.launch {
            try {
                emit(
                    dao = dao,
                    source = c.source,
                    start = Instant.ofEpochMilli(c.startMs),
                    durationS = durS
                )
            } catch (_: Throwable) {}
        }
        current = null
    }

    // ---------- Detectors ----------

    private fun detectYouTube(root: AccessibilityNodeInfo): String? {
        val shortsIds = listOf(
            "com.google.android.youtube:id/reel_recycler",
            "com.google.android.youtube:id/reel_watch_player",
            "com.google.android.youtube:id/shorts_container",
            "com.google.android.youtube:id/reel_player_page_container"
        )
        if (anyNodeIdPresent(root, shortsIds)) return "youtube.shorts"

        val videoIds = listOf(
            "com.google.android.youtube:id/watch_player",
            "com.google.android.youtube:id/player_fragment_container",
            "com.google.android.youtube:id/player_control_overlay"
        )
        if (anyNodeIdPresent(root, videoIds)) return "youtube.video"

        return null
    }

    private fun detectInstagram(root: AccessibilityNodeInfo): String? {
        val reelsIds = listOf(
            "com.instagram.android:id/clips_viewer_view_pager",
            "com.instagram.android:id/clips_viewer",
            "com.instagram.android:id/reels_viewer"
        )
        if (anyNodeIdPresent(root, reelsIds)) return "instagram.reels"

        val storiesIds = listOf(
            "com.instagram.android:id/reel_viewer_root",
            "com.instagram.android:id/reel_viewer_texture_view_container"
        )
        if (anyNodeIdPresent(root, storiesIds)) return "instagram.stories"

        val feedIds = listOf(
            "com.instagram.android:id/feed_fragment_main_recyclerview",
            "com.instagram.android:id/main_feed_recycler_view",
            "com.instagram.android:id/rv_feed"
        )
        if (anyNodeIdPresent(root, feedIds)) return "instagram.feed"

        return null
    }

    // ---------- Helpers ----------

    private fun anyNodeIdPresent(root: AccessibilityNodeInfo, ids: List<String>): Boolean {
        for (id in ids) {
            if (hasNodeId(root, id)) return true
        }
        return false
    }

    private fun hasNodeId(root: AccessibilityNodeInfo, id: String): Boolean {
        val nodes = try {
            root.findAccessibilityNodeInfosByViewId(id)
        } catch (_: Throwable) {
            return false
        } ?: return false
        val found = nodes.isNotEmpty()
        nodes.forEach { it?.recycle() }
        return found
    }

    /**
     * Cheap diagnostic: return up to [max] resource IDs seen in a BFS from root.
     * Used by detector.miss to log what we're looking at when rules don't match.
     */
    private fun topLevelViewIds(root: AccessibilityNodeInfo, max: Int): List<String> {
        val out = mutableListOf<String>()
        val queue: ArrayDeque<AccessibilityNodeInfo> = ArrayDeque()
        queue.addLast(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 200 && out.size < max) {
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

    companion object {
        const val TAG = "ScrollantirDetect"
        private const val THROTTLE_MS = 500L

        @Volatile private var instance: ContentDetectorService? = null

        private val _enabled = MutableStateFlow(false)
        val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

        /** Called from UsageStatsPoller when user leaves a target package. */
        fun notifyForegroundLeft() {
            instance?.onForegroundLeftTarget()
        }
    }
}
