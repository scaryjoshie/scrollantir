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
Because of this derivation, `ContentDetectorService.kt` carries a
GPL-3.0-or-later header and is the only GPL-licensed file in the repo —
the rest of scrollantir remains MIT (see [LICENSE](LICENSE)).

## ActivityWatch

- Repository: https://github.com/ActivityWatch
- License: MPL-2.0

Scrollantir uses ActivityWatch's Mac watchers on the desktop side:

- `aw-watcher-window` and `aw-watcher-afk` are installed unchanged as
  part of the stock ActivityWatch bundle.
- `aw-watcher-web` is forked — our patch (`mac-extension/zen-container.patch`,
  pinned against upstream commit `50d1c1c`) adds a `container` field to
  each tab-heartbeat's `data`, resolved from
  `browser.contextualIdentities`. This is what lets the dashboard slice
  Zen time by workspace. The fork is built as
  `mac-extension/artifacts/aw-watcher-web-zen.xpi` and installed
  directly into Zen; the official `aw-watcher-web` is not loaded
  alongside it.

Because the upstream is MPL-2.0, the patched source files stay MPL-2.0
and are reproducible from upstream + `zen-container.patch`. The rest of
scrollantir (the Python forwarder, the Android app) is not a derivative
work of aw-watcher-web.

The scrollantir forwarder does **not** depend on ActivityWatch's
`aw-sync` or `aw-client`; it talks directly to AW's local SQLite
read-only and to our own ingest endpoint.
