package app.scrollantir.ui

import app.scrollantir.db.AppTotal
import app.scrollantir.db.EventRow

/**
 * Rules for what counts as user-facing signal vs. noise. Applied at view
 * time only — the raw events table never filters.
 */
object EventFilter {

    /**
     * Packages suppressed from the Today dashboard. Launchers and normal
     * apps are NOT here — Josh explicitly wants home-screen time visible.
     */
    private val NOISE_PACKAGES: Set<String> = setOf(
        "com.android.systemui",
        "com.google.android.inputmethod.latin",
        "com.google.android.permissioncontroller",
        "android",
        "com.android.settings.intelligence"
    )

    /**
     * Our own package — always hide from time-tracking views since scrollantir
     * itself "foregrounds" every time the user checks the dashboard.
     */
    private const val SELF_PACKAGE = "app.scrollantir"

    /** Hide foreground visits shorter than this in the Today list. */
    const val MIN_FOREGROUND_S: Double = 2.0

    fun isSignalApp(pkg: String): Boolean {
        return pkg !in NOISE_PACKAGES && pkg != SELF_PACKAGE
    }

    fun filterAppTotals(all: List<AppTotal>): List<AppTotal> {
        return all.filter { it.app.let { pkg -> isSignalApp(pkg) } && it.totalS >= MIN_FOREGROUND_S }
    }

    /**
     * For the Events debug list — signal-only filter. Hides the diagnostic
     * sources, noise packages, and brief foreground visits.
     */
    fun isSignal(event: EventRow): Boolean {
        if (event.source.startsWith("debug.")) return false
        if (event.source == "detector.miss") return false
        return when (event.source) {
            "system.foreground" -> {
                val pkg = extractApp(event.dataJson) ?: return false
                isSignalApp(pkg) && event.durationS >= MIN_FOREGROUND_S
            }
            else -> true
        }
    }

    fun extractApp(dataJson: String): String? {
        // Cheap grab without JSON parse: dataJson is like {"app":"com.x.y"} or {}
        val needle = "\"app\":\""
        val i = dataJson.indexOf(needle)
        if (i < 0) return null
        val start = i + needle.length
        val end = dataJson.indexOf('"', start)
        if (end < 0) return null
        return dataJson.substring(start, end)
    }

    fun humanizeMode(source: String): String = when (source) {
        "youtube.shorts" -> "YouTube Shorts"
        "youtube.video" -> "YouTube (video)"
        "instagram.reels" -> "Instagram Reels"
        "instagram.feed" -> "Instagram Feed"
        "instagram.stories" -> "Instagram Stories"
        "tiktok.feed" -> "TikTok"
        else -> source
    }

    /** For a content-mode source, the parent app's package (for icon lookup). */
    fun parentAppForMode(source: String): String? = when {
        source.startsWith("youtube.") -> "app.revanced.android.youtube"  // or com.google.android.youtube
        source.startsWith("instagram.") -> "com.instagram.android"
        source.startsWith("tiktok.") -> "com.zhiliaoapp.musically"
        else -> null
    }
}
