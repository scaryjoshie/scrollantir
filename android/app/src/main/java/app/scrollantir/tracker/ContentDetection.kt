package app.scrollantir.tracker

/**
 * Target packages for the AccessibilityService. Kept as a single source of
 * truth so UsageStatsPoller can signal session-close when leaving any of
 * them, and the manifest's packageNames filter stays in sync.
 */
object ContentDetection {
    const val PKG_YOUTUBE = "com.google.android.youtube"
    const val PKG_YOUTUBE_REVANCED = "app.revanced.android.youtube"
    const val PKG_INSTAGRAM = "com.instagram.android"
    const val PKG_TIKTOK = "com.zhiliaoapp.musically"

    val TARGET_PACKAGES: Set<String> = setOf(
        PKG_YOUTUBE,
        PKG_YOUTUBE_REVANCED,
        PKG_INSTAGRAM,
        PKG_TIKTOK
    )
}
