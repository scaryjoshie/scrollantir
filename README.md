# Scrollantir

A personal "palantir for yourself" time-tracker. Structured activity events
across Mac and Android, owned end-to-end, Postgres as source of truth.

## Status

Single-user personal project. Not production-ready. No multi-user support,
no stability guarantees, no promises of backward-compatible schemas. The
whole thing exists because I wanted one and couldn't find anything that
captured what I cared about without also shipping my data to someone else.

If you find it useful, fork it.

## What's here

| Path | What it is |
| --- | --- |
| `android/` | Android collector app (sideloaded) |
| `mac-forwarder/` | macOS launchd agent reading ActivityWatch |
| `mac-extension/` | forked `aw-watcher-web` adding Zen container tracking |
| `supabase/` | schemas, migrations, edge functions |
| `scripts/admin.py` + `./admin` | local CLI for device/token/role lifecycle |
| `docs/` | **read `docs/README.md` next** for the real tour |

## Getting started

There's no one-shot install — this is a handful of coordinated pieces.
Start here:

- `docs/README.md` — index of the docs, read first
- `docs/setup.md` — step-by-step for Android + Mac + Supabase setup
- `docs/architecture.md` — how the pieces fit together

## License

MIT. See [LICENSE](LICENSE).
