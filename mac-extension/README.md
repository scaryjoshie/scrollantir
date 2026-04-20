# aw-watcher-web (scrollantir zen fork)

A minimal patch on top of ActivityWatch's `aw-watcher-web` that adds a
**container** field to each tab-heartbeat's `data`. Josh uses one
Firefox container per Zen workspace, so `data.container` effectively
labels each event with the workspace it came from, which lets the
dashboard slice time by workspace instead of just by tab URL.

## What the patch changes

- `src/manifest.json` (Firefox block)
  - Adds `contextualIdentities` and `cookies` permissions.
  - Renames the extension and gives it a new gecko id
    (`aw-watcher-web-zen@scrollantir.local`) so it doesn't collide with
    any AMO-installed copy of the official extension.
- `src/background/heartbeat.ts`
  - Resolves `tab.cookieStoreId` to the container's human name via
    `browser.contextualIdentities.get`. Results are cached per
    `cookieStoreId`. The default store (`firefox-default`) and resolution
    failures both map to `"no-container"`. Guarded so Chrome / Safari
    builds don't error on the missing API.
  - Adds the resolved name to the heartbeat payload as `data.container`.

That's it. The forwarder reads this field out of AW's SQLite (under
`datastr`) and forwards it as `zen.tab`'s `data.container`.

## Building the xpi

```bash
./build.sh
```

Pinned to upstream commit `50d1c1cb7efa758d63b2509bcf5239b18183550c`.
Requires `git`, Node 20+, and `npm`. Produces
`artifacts/aw-watcher-web-zen.xpi`.

A pre-built xpi is checked in at `artifacts/aw-watcher-web-zen.xpi`
(~100 KB) so you don't have to rebuild unless you edit the patch.

## Installing in Zen

Zen allows unsigned extensions — no AMO review needed. Two install paths:

### Dev (temporary, cleared on restart)

1. Navigate to `about:debugging#/runtime/this-firefox` in Zen.
2. Click **Load Temporary Add-on…** and select
   `artifacts/aw-watcher-web-zen.xpi` (or the unzipped `manifest.json`).

### Persistent

1. In `about:config`, set `xpinstall.signatures.required` to `false`.
2. Drag `artifacts/aw-watcher-web-zen.xpi` onto a Zen window.
3. Confirm the install prompt.
4. Open the extension's options page and point it at your local
   aw-server-rust (default `http://127.0.0.1:5600`).

## Verifying container capture

With the extension installed and ActivityWatch running:

```bash
sqlite3 ~/Library/Application\ Support/activitywatch/aw-server-rust/sqlite.db \
  "SELECT datastr FROM events \
   WHERE bucketrow = (SELECT key FROM buckets WHERE id LIKE 'aw-watcher-web-firefox%') \
   ORDER BY id DESC LIMIT 3"
```

The `datastr` JSON should include a `"container"` key. Non-container
tabs report `"no-container"`; tabs in a workspace report that
workspace's container name.

## Upstream attribution

See `../CREDITS.md`. The upstream is MPL-2.0; our patch is a small
modification that the MPL accommodates.
