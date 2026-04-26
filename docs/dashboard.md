# Dashboard — planned module

Main portal to access Scrollantir data. Originally planned as a Mac Swift
app; pivoted on 2026-04-21 to a **web-first stack** (Vite + React +
TypeScript, optionally Tauri-wrapped later). Three-timeline design below
is unchanged.

## Status

🚧 In progress; web rewrite not started.

**Completed upstream:**
1. ✅ Ingest server + Postgres — events flowing to Supabase from Mac since
   2026-04-21; phone wired same day via QR onboarding.
2. ✅ Orchestrator agent writing reports to `public.reports` — daily +
   weekly cron jobs live on Hetzner (`docs/orchestrator.md`).

**Blocking for v1:**
1. 📋 Derived/parsed location tables populated (see "Parsed data" below).
   Upstream location events from Android aren't flowing yet — in progress
   in `android/`. Dashboard can ship without location lane until they do.
2. 📋 Project classification (roadmap #8) — optional but drastically
   improves the reports by attaching `project_id` to events. Timeline
   renders fine without it; "time on what" queries don't.

**Prior attempt:** SwiftUI scaffold at `macos/`. Parked; built the data
layer correctly (schema types, query shapes) but couldn't deliver the
Notion-style blocky-timeline UI Josh wanted within the framework's
built-in charting. Read `macos/README.md` §"Known rough edges" before
retreading.

## Core concept: three stacked timelines

The Mac app shows **three horizontal timelines, stacked vertically, all sharing the same x-axis (time)**. At a glance, you see what was happening on phone, on mac, and where you physically were — cross-referenceable vertically.

```
┌──────────────────────────────────────────────────────────────────┐
│ Phone  ▕▕▕▕▕▕▕ ░░░░░ ▕▕▕ ░░░░░░░░░░ ▕▕ ░░░░░ ▕▕▕▕▕▕▕▕▕▕▕▕  │  ← chart
│ Mac    ░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░  │  ← chart
│ Loc    ●─────● ╌╌╌╌ ●─────────● ╌╌╌ ●─────────●             │  ← narrative
│       home  (walk)    class     (walk)  home                   │
│ 07:00         09:00         12:00         15:00         18:00   │
└──────────────────────────────────────────────────────────────────┘
```

### Why the location track renders differently

Phone and Mac activity is **continuous** — every minute you were either using an app or you weren't, and which app matters for every minute. Natural fit for a chart.

Location is **discrete** — you were at one named place until you transitioned to another. The information is "where, from when to when, how did you travel between them." A chart can encode this but it's wasteful: most of the pixels just repeat "still at home" in one color.

The **narrative style** (●────● ╌╌ ●────●) reads directly as a sentence: "home, walked, class, walked, home." Scannable in one glance. Same information, compressed.

Use the narrative style for the location track. Chart style for phone and mac.

### Vertical cross-reference

Because all three tracks share one x-axis, you can drop a vertical cursor at any time and see simultaneously:
- What phone app was in use
- Whether mac was active
- Where you were

This is the Palantir-for-yourself payoff: the cross-product of three streams at a timestamp.

## Parsed data — why raw events aren't enough

Rendering the three-timeline view needs derived state that raw `events` rows don't give you directly:

### For the phone/mac tracks (chart style)
- Already fine. `events` rows with `source` + `timestamp` + `duration_s` map directly to colored rectangles.

### For the location track (narrative style)
You need:
- **Visits** — "at place X from time A to time B" — consolidated from raw `phone.location.reading` rows matched against `places`, with the bathroom-break gap tolerance rule (see [places.md](places.md)).
- **Travel legs** — "walked from visit_N to visit_{N+1}" — derived from the period between consecutive visits + the active `phone.activity.state` during that period, with distance computed from endpoint coords (or path summary if Tier 2).
- **Activity spans** — just `phone.activity.state` events, usable as-is.

### Architectural options for parsed data

Three ways to compute/store the derived tables:

| Approach | Pros | Cons |
|---|---|---|
| **Postgres materialized view** | SQL only, refresh on ingest via trigger | Materialized views can get stale; refresh-all-on-insert is expensive; partial refresh is awkward |
| **Derived tables populated by trigger** | Incremental, fast reads | Trigger logic is in PL/pgSQL — harder to iterate |
| **Query-time computation** | Zero storage; always fresh | Slow on large ranges; same logic re-runs every dashboard query |

**Recommendation: derived tables with a periodic worker, not trigger.** The phone forwards in 15-min batches, not real-time, so deriving inside a worker that runs every 10 min is fine latency-wise. Worker is Python/TypeScript, easier to evolve than PL/pgSQL.

Table shapes:

```sql
CREATE TABLE place_visits (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  place_id UUID REFERENCES places(id),   -- NULL for "travel/unknown"
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ NOT NULL,
  brief_exit_count INT DEFAULT 0,         -- bathroom-break consolidation count
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX place_visits_user_time ON place_visits (user_id, start_ts);

CREATE TABLE travel_legs (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  from_visit_id UUID REFERENCES place_visits(id),
  to_visit_id UUID REFERENCES place_visits(id),
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ NOT NULL,
  dominant_activity TEXT,                 -- walking/biking/vehicle
  distance_m REAL,                        -- straight-line (Tier 1) or path-sum (Tier 2)
  reading_count INT,                      -- how many GPS samples in between
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX travel_legs_user_time ON travel_legs (user_id, start_ts);
```

`place_visits.place_id IS NULL` means "unmatched" (user was somewhere, no place record covers it). Rendering treats that as a blank gap or "unknown location."

### What the dashboard queries per day

```sql
SELECT * FROM place_visits
  WHERE user_id = :me AND start_ts >= :day_start AND end_ts <= :day_end
  ORDER BY start_ts;

SELECT * FROM travel_legs
  WHERE user_id = :me AND start_ts >= :day_start AND end_ts <= :day_end
  ORDER BY start_ts;
```

Two small result sets. Join them chronologically client-side → render narrative.

Phone and mac tracks use raw `events` queries, already well-suited to chart rendering.

## Read-path auth

Direct Postgres over TLS as `user_role`, using the DSN stored in the Mac
login keychain. No Supabase JS/anon-JWT layer — it doesn't fit our
role-based credential model. See `docs/data-flow.md` §"Credential map"
and `docs/supabase.md` for trust-boundary details. RLS policies on
`public.*` scope reads to `user_role`; `user_id` isn't a column on
scrolllantir tables today (single-user install).

## Open design questions

- **Zoom / pan behavior** — do all three tracks pan-zoom together (shared cursor), or independently? Probably together.
- **Tap interactions** — on the location track, tap a visit node to see "what apps were used while there" — requires cross-source query, but the data is all in `events`.
- **Density** — at one-month zoom, the location narrative collapses to "lots of dots" — need a multi-day rollup (e.g., heatmap or sparkline of time-per-place).
- **Timezone** — all stored UTC, rendered in device-local zone. Crossing timezones (travel) is a tricky UI — probably render in the zone you were in at that moment, not the current device zone.

## Relationship to other docs

- [location.md](location.md) — upstream collection (raw `phone.location.*` and `phone.activity.*`)
- [places.md](places.md) — named-location layer feeding the visits derivation
- [architecture.md](architecture.md) — overall pipeline; this doc concerns the read path and UI

## Not yet decided

- Whether to build web (Next.js) in parallel with Mac Swift or skip. Mac-only likely sufficient for one-user case.
- Whether the Swift app runs its own cache or goes straight to Supabase every time. Probably thin client + Supabase-as-cache.

---

## Agent handoff — web v1 (2026-04-21)

Fresh-agent briefing. Read everything above for the *design* vision;
this section is the *current state + how to start building*.

### Direction change

The "Mac Swift app primary" line at the top of this doc is superseded.
**v1 is a web app** (Vite + React + TypeScript, served locally), with
the option to wrap in Tauri later if a .app bundle becomes important.
Reasons in brief: timeline UX was the weakest part of SwiftUI (Swift
Charts gives hair-thin bars, not the Notion-blocky-zoomable look Josh
wants), and the JS ecosystem has 5+ mature timeline libraries that hit
that look out of the box. The previous SwiftUI attempt at `macos/` is
parked — preserved for plumbing patterns, not for UI code.

### Current data plane state

What's actually flowing (this changes the planning from "all derived
tables first" to "render what we already have, layer classification on
top later"):

- **`public.events`** populated live: ~3400+ events from Mac, a
  growing stream from phone (Android wire-up shipped 2026-04-21).
- **`public.events_enriched`** view available — joins events with
  device metadata and `source_tags` into a tags array.
- **`public.reports`** populated daily by the orchestrator agent
  (see `docs/orchestrator.md`). Daily digests at 07:00 CT, weekly
  reports Sunday 09:00 CT. Tag-labeled `{daily}` / `{weekly}` /
  `{smoke}`.
- **`place_visits`, `travel_legs`, `places`** tables: **not yet
  built.** The narrative-style location track this doc describes
  depends on them. For v1, leave the location lane as a placeholder
  that shows "no events" until that derivation ships.
- **Project classification (`event_project_links`, `classify_event`
  RPC)**: not yet built. Also a dependency for "time on project X"
  queries, also blocked on separate roadmap work (#8). The timeline
  for v1 shows raw-source-level coloring, not project-level.

### v1 scope (explicit)

Two pages, nothing more:

1. **Reports** — feed of cards from `public.reports` newest-first.
   Filter chips: All / Daily / Weekly. Click a card → detail pane
   with rendered markdown body.
2. **Timeline** — 24-hour view with date picker. Three stacked lanes:
   **Mac**, **Phone**, **Location**. Events as color-coded rounded
   blocks. **Zoom** (scroll-wheel / ⌘-+/-) and **pan** (drag). Hover
   tooltip with source + duration + `data.app`/`data.title` if
   present. Location lane shows "no events yet" — that's fine.

Out of scope for v1: chat, edit/write, settings, project view,
search, any of the derived-tables work in the §"Parsed data" section
above. Those come later.

### Recommended stack (evaluate and confirm with Josh before scaffolding)

- Vite + React + TypeScript
- shadcn/ui or Radix + Tailwind for UI primitives
- Timeline: evaluate `vis-timeline`, `react-calendar-timeline`, or a
  custom Canvas/SVG implementation. Pick whichever gets the
  *Notion-blocky* look with the least custom CSS. Josh will tell you
  fast which one feels right — propose and confirm before building.
- Markdown: `react-markdown` + `remark-gfm`
- Postgres access: **`postgres` (porsager/postgres)**, NOT
  `@supabase/supabase-js`. supabase-js is built around JWT/anon auth,
  which doesn't match our role-based DSN model.

### Connecting to the live DB

`user_role` is the dashboard credential (SELECT on `public.*`; no
writes). Retrieve from macOS login keychain:

```bash
security find-generic-password -s scrollantir -a user-role -w
```

Output format:
`postgresql://user_role.PROJECT:PASSWORD@aws-1-us-east-2.pooler.supabase.com:5432/postgres`

Export as Vite env var for dev:

```bash
export VITE_DATABASE_URL="$(security find-generic-password -s scrollantir -a user-role -w)"
npm run dev
```

**Do not commit the DSN.** Keychain is the canonical source.

### Schema quick-reference (v1 only)

**`public.reports`**
- `id uuid`, `title text`, `body text` (markdown), `tags text[]`,
  `window_start timestamptz?`, `window_end timestamptz?`,
  `created_at timestamptz`, `deleted_at timestamptz?`.
- Always `WHERE deleted_at IS NULL`.

**`public.events_enriched`** (view)
- `id uuid`, `device text` (`'mac'` | `'phone'`), `device_label text`,
  `source text`, `timestamp_utc timestamptz`,
  `duration_s double precision` **(not int — SwiftUI attempt hit
  this)**, `data jsonb`, `tags text[]`, `received_at timestamptz`.
- No `deleted_at` on events; they're append-only from ingest.

Common source values worth color-coding:
`system.foreground`, `system.window`, `mac.zen.tab`, `system.afk`,
`system.screen`, `system.unlock`, `system.unlocked`, `youtube.shorts`,
`instagram.reels`, `tiktok.feed`, `detector.miss`. Target 8-12 total
colors; group short-form video sources under one hue if the legend
gets busy.

### Pitfalls learned in the SwiftUI attempt (don't repeat)

1. **`events.duration_s` is `double precision`**, not integer. Model
   as JS `number`.
2. **TLS cert chain**: swift-nio-ssl couldn't verify Supabase pooler
   certs. Node's `postgres` uses system trust anchors on macOS, so
   this should be fine. If you hit a verify-error, fall back to
   `ssl: { rejectUnauthorized: false }`.
3. **Timeline density**: 24h on Mac = ~1000-5000 events. Naive blocky
   rendering overlaps. Consider aggregating adjacent same-source
   events into longer blocks at low zoom.
4. **Reports have GFM tables + code blocks**: use `react-markdown` +
   `remark-gfm`. Don't hand-roll markdown.
5. **`tags text[]`**: when filtering server-side use `= ANY(tags)`;
   when serializing across the wire, flatten to `string[]`.

### "Done" definition for v1

- `npm run dev` serves at `http://localhost:5173`.
- Reports tab: list of last 50 reports, cards, filter chips,
  click-to-view with markdown rendered.
- Timeline tab: date picker, three lanes, blocky color-coded events,
  working zoom and pan, hover tooltips.
- Works end-to-end against the live Supabase pooler DSN from
  `scrollantir/user-role`.
- The parked `macos/` directory remains as historical reference.
  Don't modify it; new code lives under `dashboard/` (or whatever
  subdirectory name Josh prefers — ask before committing).

### One rule before scaffolding

Propose the stack + timeline library pick back to Josh and get
confirmation *before* running `npm create vite`. The Swift attempt
lost a couple hours picking defaults that didn't match the design
goal. Propose the library evaluation first.

### Parallel work you should not touch

- `orchestrator/` — live on Hetzner, cron-writing reports. Don't
  modify.
- `scripts/admin/`, `supabase/` — admin CLI + DB schema, out of
  scope.
- `android/`, `mac-forwarder/` — data collection; out of scope.
- `macos/` — parked. Leave as-is.

Your playground is a fresh `dashboard/` directory (or similar). The
`docs/` tree is fair game for notes, but ask Josh before major
rewrites of anything other than this §Agent handoff section.
