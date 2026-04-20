# Credits

## DigiPaws — AccessibilityService detection patterns

The content-mode detectors in `android/app/src/main/java/app/scrollantir/tracker/ContentDetectorService.kt`
(which distinguishes YouTube Shorts/video, Instagram Reels/feed/stories, and
TikTok) are derived from the approach used by DigiPaws:

- Repository: https://github.com/nethical6/digipaws
- License: GPL-3.0

DigiPaws is an open-source Android screen-time / distraction-blocking app.
Its approach of filtering the AccessibilityService to target packages only,
walking the view tree for known resource IDs, and treating detection misses
as signals of app-version drift informed this implementation.

Our code is not a line-for-line port, but the heuristic is the same and
the resource IDs we probe were identified by inspecting DigiPaws' detectors
(which are actively maintained against current YouTube/Instagram/TikTok UIs).
If you open-source scrollantir, the detector file should carry a GPL-3.0
header or the project should be relicensed GPL-3.0 compatible.

## ActivityWatch

- Repository: https://github.com/ActivityWatch
- License: MPL-2.0

Scrollantir uses ActivityWatch's Mac watchers (window, AFK, web) unchanged on
the desktop side. We fork `aw-watcher-web` to add a container field for Zen
workspace tracking.
