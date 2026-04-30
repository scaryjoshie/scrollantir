# Session 2026-04-30 — Overnight autonomous run

User stepped away ~1 AM CT with a list of overnight asks; this is the
status report for morning review.

## High-level summary

All major asks landed:
- ✅ At-a-glance / `/summary` page
- ✅ Trends / `/trends` page
- ✅ Display names ("Pixel Launcher" not `com.google.android.apps.nexuslauncher`)
- ✅ Path smoothing (real urban-multipath spike-drop, not vibes)
- ✅ Tracking-gap rows in /today timeline
- ✅ Phase B executed (soft tree model, classifier rewrite, pre-29 wipe)
- ✅ Phase D executed (zen container + URL host + app context plumbing)

5 background agents ran in parallel during the night. Both classifier
reclassification slots used per user authorization.

## Commits on `donut-drilldown` (main..HEAD)

| Commit | Item |
|---|---|
| `2c6998f` | Caddy zstd + gzip — chunks payload 102KB → 10KB |
| `34bd573` | Lazy-fetch chunks by time window (drops O(N) parent_id LATERAL) |
| `b732ca2` | Sleep render-as-span (drops redundant wake Moment) |
| `52ba7c9` | Drop unused `derived_events_start_desc` index |
| `854e33d` | Phase B revised — soft tree model (drafts) |
| `7574cd6` | Project slugs render as curated names via useProjects() |
| `98cf0be` | Unnamed OSM polygons → "Unnamed dormitory" via usePlaceLabels() |
| `1637cf5` | Friendly leg distance + "Mixed-use" chip |
| `9599905` | Tracking-gap rows in /today timeline |
| `8576ed6` | Migration 0017 — `v_daily_summary` + `v_project_activity` |
| `9c51b1b` | Extracted `Donut` to shared component |
| `edfb446` | travel_leg path smoothing (urban-multipath spike-drop + dedup) |
| `acd446e` | `/summary` (at-a-glance) + `/trends` pages |
| `76ffd31` | **Phase B EXECUTED** on Hetzner |
| `25ac7a3` | Migration 0018 draft (Phase D classifier context) |
| `57784af` | Migration 0018 fix (TRUNCATE before PK swap) |
| `d919dbe` | **Phase D EXECUTED** — context-keyed classifier |
| `a844456` | TENET 5a: deploy recipe must include `--build` |

## Production state (as of report)

- Pre-29 events deleted: 4,872 events + 19 derived rows (one-time auth)
- Migrations 0014-0018 all applied
- Reclassification draining at ~10/min (Cerebras → Groq fallback when 429s)
- Phase D context disambiguation working: `Dashboard` + `Zen Browser` titles
  on `canvas.northwestern.edu` correctly tag `school/work` instead of being
  ambiguous

## Key decisions made autonomously

1. **Tree model: SOFT, not strict-IFF.** Live data had 110 rows that would
   have failed strict IFF. New model: project_slug and category are
   independent axes. Added `projects.default_category` as a soft hint.
2. **Pre-29 deletion: executed** per user one-time authorization. Tenet 1
   not changed; this was an explicit exception.
3. **Cache reset: used 2 of 2 slots.**
   - Slot 1: post-Phase-B prompt rewrite (Discord = work, refined play def)
   - Slot 2: post-Phase-D context plumbing (zen + URL + app)
4. **Phone deploy: skipped** per user note (stops tracking; marginal benefit).
5. **Path smoothing: shipped server-side fix.** Diagnosis showed urban
   multipath spikes at impossible walking speeds, not generic noise.
   Activity-aware spike-drop (3.0 m/s walking, 5.5 running, 11.0 biking,
   40.0 driving) + sub-second dedup.
6. **Phase G (chunk coalesce) retired.** User clarified heavy alt-tabbing
   is real signal, not noise.

## Lessons from the night

1. **Deploy recipe**: `rsync + restart` ≠ deploy. Must `--build`. Logged
   as TENET 5a.
2. **Rate-limit math**: BATCH_SIZE=20 + zero inter-call sleep blew past
   Cerebras + Groq free-tier RPM caps. Fixed: BATCH=10 + 0.7s sleep.
3. **View-time computed columns are filter traps**: PostgREST `?col=eq.X`
   on a LATERAL-computed column makes Postgres compute the column for
   every row before filtering — O(N) scans. Time-window queries against
   real indexed columns are trivially fast.

## Outstanding items

- Reclassification still draining (~30 min more for full convergence)
- Dashboard still has zero tests (audit-flagged structural gap; not
  blocking)
- Mobile responsiveness on /summary + /trends is "graceful stacking only"
  per agent — desktop-first by spec, deferred
- TENETS.md consolidated to 11 numbered tenets + 1 sub-tenet (5a)

## Files of note

- `docs/TENETS.md` — durable principles, including new 5a deploy lesson
- `docs/TODO.md` — full status + rollback table
- `docs/sessions/session-2026-04-30-overnight.md` — this file

See you in the morning.
