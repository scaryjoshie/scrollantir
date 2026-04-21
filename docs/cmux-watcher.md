# Scrollantir — cmux per-tab watcher (deferred)

## Status

💡 **Deferred.** Not planned for imminent build. Documented here so a
future session can pick it up quickly once a downstream consumer
actually needs per-tab granularity.

Workspace-level tracking already works for free via `system.window`
events (app=`cmux`, title=`<workspace name>`). This module is
strictly about *tab-level* (cmux "surface") detail inside a
workspace.

## Why deferred (2026-04-21 decision)

- **Signal overlap.** You care mostly about workspace identity today,
  which we already capture.
- **Volume.** cmux tab switches are frequent (multiple per minute for
  active dev). Emitting a Pattern B event on every transition would
  roughly double the Mac event volume while adding low marginal
  analytic value until a downstream consumer demands it.
- **No consumer yet.** Reports and projects-layer classifier (#8)
  don't need tab-level detail until we're asking questions like
  "average focus duration within a workspace" or "how often do I
  context-switch between tabs while in Scrollantir workspace."
- **Data not lost.** Ghostly's inactive. When we turn this on later,
  we only get tab-level data from that moment forward — but nothing
  we need now depends on retroactive tab history.

## When to un-defer

Build this when one of the following becomes true:

- The classifier (roadmap #8) wants `cwd` / `cmd` per tab to
  distinguish "Scrollantir workspace, editing Scrollantir code" from
  "Scrollantir workspace, reading YouTube" with evidence beyond the
  window title.
- You want to answer focus-decomposition questions inside a
  workspace (avg uninterrupted tab-focus span, tab-switching rate
  as a distraction proxy).
- You want cwd/cmd as a project-attribution signal — `cwd` starting
  with `~/dev/scrollantir` is strong evidence of
  Scrollantir project work regardless of which workspace holds it.

## Design (from 2026-04-21 subagent investigation)

### cmux is `manaflow-ai/cmux`

Native macOS app (Swift/AppKit + libghostty). Installed at
`/Applications/cmux.app`, bundle `com.cmuxterm.app`. Embedded CLI at
`/Applications/cmux.app/Contents/Resources/bin/cmux` speaks to a
Unix socket at `~/Library/Application Support/cmux/cmux.sock`.
Authenticated via `CMUX_SOCKET_PASSWORD` env var.

Upstream: https://github.com/manaflow-ai/cmux

### IPC surface (documented CLI)

- `cmux tree --all [--id-format both]` — one-shot snapshot of the
  whole hierarchy (windows → workspaces → panes → **surfaces**).
  Surfaces = tabs.
- `cmux current-window`, `cmux current-workspace` — frontmost.
- `cmux list-workspaces`, `cmux list-panes --workspace <ref>`,
  `cmux list-pane-surfaces --workspace <ref> --pane <ref>` — hierarchical.
- `cmux set-hook <event> <command>` — hook system. May expose a
  `surface-focus` / `tab-focus` event we can subscribe to instead of
  polling. `cmux set-hook --list` to enumerate.
- `cmux capabilities`, `cmux ping`, `cmux version` — meta.
- Session state JSON mirror: `~/Library/Application Support/cmux/session-com.cmuxterm.app.json`
  (~18 KB). Might be read-directly-faster than shelling out.

Fallback: AppleScript SDEF at
`/Applications/cmux.app/Contents/Resources/cmux.sdef`
(`NSAppleScriptEnabled=true` in Info.plist) if the socket path ever
becomes unavailable.

### Probe commands to validate before coding

All read-only, fast:

```bash
# Auth works from outside a cmux session? Real gate.
/Applications/cmux.app/Contents/Resources/bin/cmux ping

# Schema of tree output; also whether cwd/cmd are present per surface.
/Applications/cmux.app/Contents/Resources/bin/cmux tree --all --id-format both 2>&1 | head -80

# Hooks — if there's surface-focus event, skip polling entirely.
/Applications/cmux.app/Contents/Resources/bin/cmux set-hook --list

# Session JSON top-level structure — might be shortest path.
jq 'keys' ~/Library/Application\ Support/cmux/session-com.cmuxterm.app.json
```

Pick approach after seeing probe output. Probable winner: poll
`cmux tree --all` every 2s. Hook path, if it exists, is better.

### Event schema

```
source = "mac.cmux.tab"
data   = {
  "window_id":       "<uuid>",
  "workspace_id":    "<uuid>",
  "workspace_name":  "Scrollantir",
  "pane_id":         "<uuid>",
  "surface_id":      "<uuid>",
  "surface_index":   2,
  "surface_title":   "editor",
  "cwd":             "~/dev/scrollantir",                # if available
  "cmd":             "nvim"                               # if available
}
```

Identity is UUIDs, not names. Workspace/tab renames don't fragment
history — the name is a mutable attribute recorded at event-end time.

### Container/workspace as context, not identity (design principle)

Worth re-stating here because it's easy to forget: being in the
Color3 workspace does not mean you're working on Color3. The
watcher's job is to emit the raw fact of *which tab was focused when*.
The projects-layer classifier (#8) synthesizes attribution from
multiple signals (workspace + app + url + cwd + cmd + duration +
time-of-day), ideally with confidence + user confirmation, rather
than collapsing workspace-identity into project-identity at ingest
time.

This matters because several useful queries — "how focused am I in
Color3 workspace?", "what drags me out of Scrollantir work?" —
require workspace and activity to remain independent signals.

### Deployment shape

- **Separate launchd agent** (`com.scrollantir.cmux-watcher.plist`),
  not bolted into `mac-forwarder/forwarder.py`. Reasons:
  - cmux socket needs `CMUX_SOCKET_PASSWORD` from Keychain — isolated
    dependency.
  - Polling cadence (~2 s) is tighter than the forwarder's 30 s batch
    cadence.
  - Clean failure domain: if cmux isn't running or the socket
    password isn't available, watcher no-ops; forwarder keeps flowing.
- **Directory:** `mac-cmux-watcher/` at repo root, sibling to
  `mac-forwarder/`. Its own `.venv`, its own `setup.sh`, its own
  `cmux_watcher.py` + plist.
- **Event emission:** write into the same ingest path as the
  forwarder (POST to `/functions/v1/ingest` with the same Mac bearer
  token), OR append to a local queue file that the forwarder drains.
  Probably the former — simpler, avoids reinventing queue semantics.
- **LoC estimate:** ~150 lines Python for the watcher + ~20 line
  plist + ~40 line setup.sh.
- **Language + runtime:** match `mac-forwarder`. Python 3.9+,
  `from __future__ import annotations` for typing.

### Failure modes to handle

- **cmux not running** — `cmux ping` errors; sleep 30 s, retry. No
  synthetic events.
- **Socket password missing / rotated** — surfaces as non-zero exit
  from `cmux ping`. Log once, back off, don't spam.
- **App restart** — all IDs change. Close the currently-open
  duration event with `ts_end = last_seen_ts`, start fresh on next
  successful poll.
- **Workspace / surface rename mid-session** — IDs stable; names
  carry as mutable attributes at event-end time.
- **Sparkle auto-update** — treat like app restart.
- **cmux version bump changes CLI output** — include the running
  cmux version in event data (`"cmux_version": "0.63.1"`) for
  forward-debug.

## Related

- `mac-forwarder/` — the reference implementation this would mirror
  (Python 3.9, launchd, Keychain-for-token).
- `docs/architecture.md` §"Source vs. data vs. tags" — why cwd/cmd/
  workspace go in `data`, not `source`.
- `docs/projects.md` — the classifier that would consume this signal.
- `docs/roadmap.md` — this module sits under "Ideas / future bets".
