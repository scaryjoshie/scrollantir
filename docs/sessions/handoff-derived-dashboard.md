# Handoff — derived views + dashboard timeline

You are picking up scrollantir, a personal "palantir for yourself"
time tracker. Data collection is **stable as of 2026-04-28**: phone
and Mac both posting to the self-hosted runtime/ stack on Hetzner;
shorts/reels detection just got a major fix; GPS now uses
HIGH_ACCURACY. The next phase is **building the deriver runtime,
shipping derived views, and building the day-narrative dashboard
page**. This doc is the entry point for that work.

> **Don't write code yet.** First read the four primary docs below
> and then walk through the §"Open questions to confirm with Josh"
> at the bottom as a batch. Specific design decisions need
> confirmation before scaffolding.

## What scrollantir is (one paragraph)

Structured event streams from Android (Pixel 9) and Mac (ActivityWatch
+ Python forwarder) flow into a self-hosted Postgres on a Hetzner
CAX11 VM. A Python agent process (APScheduler-driven) reads from
`agent_role`, computes derivations, writes reports + prompts via
`agent_api.*` RPCs (not yet shipped). Single-user, self-hosted,
Postgres as system of record. Web dashboard at `dashboard/` reads
through PostgREST + Caddy basic-auth. Two tables: `public.events`
(raw, immutable, append-only) and `public.derived_events` (computed,
replace-window-keyed). All specs in `docs/`.

## Reading list (this exact order, ~45 min)

1. `docs/sessions/session-2026-04-27.md` — **current operational
   reference.** URLs, deploy commands, key file map, polling
   cadences, open issues post-runtime-cutover. Skim everything,
   bookmark §"Key files / where things live."
2. `docs/sessions/session-2026-04-28.md` — yesterday's content
   detector + GPS hardening. Mostly historical for *your* work but
   confirms the dataset is now trustworthy enough to design against.
3. **`docs/data-model.md`** — the contract. Two-table model, deriver
   class hierarchy (Deterministic / LLM with `confirmation_policy`),
   derivations registry, view catalog, decision log. Most of your
   attention should go here.
4. `docs/dashboard/README.md` — what's shipped (Raw page only) vs.
   the long-term three-stacked-timelines design.
5. `docs/concepts/places.md` — places + visit consolidation. The
   first deriver to ship (`place_visit/v1`) computes against this.
6. `docs/concepts/location.md` — collection spec for raw GPS +
   activity events.
7. `docs/runtime/rebuild-plan.md` — the runtime/ stack design. Note
   the post-cutover banner; treat the migration sequence as
   historical, the deriver targets and class hierarchy as live spec.

## What's actually flowing (verified 2026-04-28)

Sources currently emitting clean data, with reliability notes:

| source | reliability | notes |
|---|---|---|
| `mac.system.window` | high | filter sub-3s flicker at deriver layer |
| `mac.system.afk` | high | canonical "actively using mac" signal (use, not focus) |
| `mac.zen.tab` | medium | `audible` under-populated; some orphan events |
| `phone.system.foreground` | high | Pixel launcher inflates; weight down |
| `phone.system.unlocked` | high | canonical "user attending phone" |
| `phone.system.screen` | high | absence = screen off |
| `phone.system.unlock` | high | point events; paired with `unlocked` |
| `phone.youtube.shorts` | high (post-2026-04-28) | only fires in immersive Shorts player; 2-match settle |
| `phone.instagram.reels` | medium | not re-verified post-yesterday; treat with caution |
| `phone.instagram.stories` | medium | same |
| `phone.tiktok.feed` | medium | wildcard rule, fires on any TikTok event |
| `phone.location.reading` | high (post-2026-04-28) | HIGH_ACCURACY GPS; ≤20m typical |
| `phone.activity.state` | medium | Android Activity Recognition; sporadic walk/still flicker — deriver's job |
| `prompt.<kind>` | n/a | user answers; pseudo-source |

What's deferred (not blocking your work):
- `cloud.github.commit`, `cloud.spotify.track`, `cloud.gcal.event` —
  service-polled "cloud" device events; spec'd, not collected.
- `mac.media.playing` (via nowplaying-cli) — planned, not collected.

The collection layer is **done for v1**. You should not need to add
new primitives to do derived views + the dashboard.

## What's blocking what (the dependency chain)

The work has a strict order. Each item gates the next:

```
1. agent_api.*  RPCs            ← required for anything that writes derived rows
   ├ replace_derived_window
   ├ upsert_report
   ├ upsert_annotation
   └ create_prompt

2. SQL views                    ← let the dashboard render summaries
   ├ events_enriched
   ├ mac_active
   ├ phone_active
   ├ idle_span
   ├ concurrent
   ├ top_apps_mac / top_apps_phone
   └ phone_activity_gated  (helper for travel_leg)

3. First derivers                ← exercise the deriver runtime end-to-end
   ├ place_visit/v1            (Deterministic; uses location + activity + places)
   ├ travel_leg/v1             (Deterministic; complement of place_visit)
   ├ session/v1                 (Deterministic; same-app focus clusters)
   └ sleep/v1                   (LLM, if_uncertain; daily 16:00)

4. Dashboard pages               ← read derived + views, render
   ├ Summary    (mac_active / phone_active / concurrent / top apps)
   ├ Timeline   (three stacked tracks; the v1 design from dashboard/README)
   └ Day narrative (the new vertical scroll; design notes below)
```

Items 1+2 are SQL-only and should land first. Item 3 unblocks the
deriver framework. Item 4 is the user-facing payoff.

## The day-narrative dashboard page (design notes)

This was workshopped with Josh on 2026-04-27. Capturing the design
conversation here so you don't have to reconstruct it.

### Goal

A vertical-scroll "what happened today" view. Stacked moments:

> 🛌 You woke up at 7:14
> 🚶 Walked to Eckhart Hall (12 min)
> 📚 Math 221 — class (50 min)
> 💻 Worked on scrollantir (1h 30m, mostly cmux + chrome on github)
> 🍔 Lunch at Bartlett (30 min)
> ...

Click any item → drill-down panel showing the constituent events.

### Two-layer segmentation (the key idea)

Don't try to make a single "narrative" deriver. The page is a
**render-side composition** over existing-but-mostly-unshipped
derivers.

- **Outer hull** = location/movement: `home → walked → class → walked → home`.
  Sparse, event-like. Reads `derived.place_visit` + `derived.travel_leg`.
  *Collapses to one block when home all day — that's correct, not a bug.*
- **Inner blocks** *within* each outer block = dominant-app clusters
  over a rolling window. So home-all-day collapses to one outer block
  but the inner gets 4–6 sub-items: "9:30–11:15 mostly cmux + github",
  "11:15–12:00 reels + Discord," etc. Reads
  `events` filtered to active masks + grouped by dominant app.

"Switched a lot vs dedicated to one thing" reads naturally as
*number of inner blocks* — implicit, no explicit label needed.

### Inner-block algorithm (first guess; tune on real data)

- Rolling 15-min windows, dominant app per window
- Merge adjacent same-dominant windows
- Stop merging when the smallest block ≥ 10 min OR ≤ 5 blocks per outer
- Mask to `mac_active ∪ phone_active` so passive/AFK time isn't credited

### Sporadic-location problem isn't your problem

`phone.activity.state` is sporadic ("walking-still-walking-still" on a
single walk). Don't filter on the render side. **`place_visit/v1`
should do this** with the STILL-overlap rule + bathroom-break tolerance
+ per-category dwell minimum. By the time the page sees
`derived.place_visit` and `derived.travel_leg`, the data should be
clean.

### "What counts as work" — defer

Project classification (`project_attribution`, roadmap #8) is the
canonical answer; not shipped. Until then, render the raw signals
(mac_active duration, dominant apps, concurrent minutes) and let
*Josh* interpret. Don't bake a "work" heuristic that becomes baggage
when project tags arrive.

### Click-to-expand has a free fallback

Three progressive disclosure layers:
- Top: sentence summary
- Middle: dominant-app bar / mini-timeline
- Bottom (deepest): deep-link to `/raw?from=...&to=...` for the actual
  event soup

Only the top two need new code; deepest layer reuses the existing Raw
page with date-window filter (current Raw page doesn't support
sub-day windows yet — small extension).

### Stats strip on top (optional, cheap)

"Today: 4h 12m mac, 1h 38m phone, 0h 23m concurrent, top apps:
cmux, chrome, slack." Maps directly to the §2 view catalog
(`mac_active`, `phone_active`, `concurrent`, `top_apps_mac`,
`top_apps_phone`).

## Dashboard read path (what already works)

You don't need to plumb auth or fetch logic — it's there:
- `dashboard/src/lib/api.ts` — PostgREST client behind Vite proxy.
  `fetchEvents(fromIso, toIso)`, `fetchReports(limit)`,
  `fetchDeviceLastSeen()`, `fetchHealth()`. Add wrappers for
  `derived_events` and your new views following the same pattern.
- `dashboard/src/pages/Raw.tsx` is the only working page. Reuse its
  scaffold (date picker, header, error/loading states) for new pages.
- Routing: `dashboard/src/App.tsx`. Add new `<Route>` entries.
- Settings/theme/storage in place; just don't get distracted by them.
- `dashboard/src/lib/settings.ts::hiddenSources()` is exported but
  never imported anywhere — pre-existing wiring miss. If you fix it,
  do it as a separate small commit.

## Open questions to confirm with Josh

Confirm as a batch before scaffolding:

1. **Implementation order** — strict bottom-up (RPCs → views → derivers
   → page) or do you build the page against mock data in parallel
   with the deriver work? The mock-first option lets the visual + UX
   iterate without blocking on deriver land. Recommended.
2. **First deriver to ship** — `place_visit/v1` per `runtime/rebuild-plan.md`,
   or start with `session/v1` (simpler, no places dependency)? The
   former is more user-visible; the latter is faster to a green deriver
   end-to-end test.
3. **`agent_api.replace_derived_window` shape** — exact signature.
   Spec'd in the data-model decision log but no SQL written. Should it
   take a JSONB array of rows or one row per call? Atomicity story.
4. **Day-narrative inner-block algorithm** — accept the "rolling 15-min,
   merge same-dominant, ≥10 min minimum, ≤5 per outer" first guess?
   Or different starting point?
5. **Drill-in target** — deep-link to existing Raw page (cheapest,
   recommended) or a separate detail panel/page?
6. **Inner-block when no outer-hull data exists** (e.g., user at home
   all day, `place_visit` has one row covering the whole day) — render
   the inner blocks alone with no outer header? With a synthetic
   "Home" outer? With a "Today" wrapper?
7. **Stats strip on day-narrative page** — yes (cheap, useful) or no
   (avoid duplication if a Summary page also shows these)?

## Don't touch

These are out of scope or live-production:
- `runtime/db/schemas/*` — schema is mostly stable; add migrations
  via a new file in `db/migrations/` (currently empty placeholder
  for dbmate), don't modify init scripts.
- `android/`, `mac-forwarder/` — collectors. Don't touch unless a
  source is actively broken (one of the post-2026-04-28 audit
  findings in session-2026-04-27 §"Open issues" might surface).
- `orchestrator/` — dead POC, archived. Don't touch.
- `supabase/` — frozen, obsolete. Don't touch.
- `scripts/admin.py` — local admin CLI. Don't touch.

## Verification before you start

```bash
# Working tree clean
git status

# Latest commits should reflect today's wins
git log --oneline -6
# expect (or newer): 8afda05, 1a57805, 3651136, 6521251, ...

# Server reachable + has events
ssh orch 'sudo docker compose -f /opt/scrollantir/repo/runtime/compose.yaml ps'
ssh orch "sudo docker exec -i scrollantir-postgres-1 psql -U scrollantir -d scrollantir -c \\
  \"SELECT source, COUNT(*) FROM events WHERE start_ts > NOW() - INTERVAL '24 hours' GROUP BY 1 ORDER BY 2 DESC;\\""

# derived_events table exists but probably empty (commit pending)
ssh orch "sudo docker exec -i scrollantir-postgres-1 psql -U scrollantir -d scrollantir -c \\
  \"SELECT COUNT(*) FROM derived_events;\\""

# Dashboard runs locally
cd dashboard && npm install && npm run dev
# → http://localhost:5173
```

## When you've finished onboarding

Reply to Josh with:

1. **2-3 sentence summary** of where the work picks up (validates
   you understood the dependency chain).
2. **Your read on each open question** — for each, propose an
   answer with one-line reasoning.
3. **Any contradictions or doc drift** you noticed across the
   reading list. Surface; don't silently pick.
4. **Proposed first commit** — likely either (a) `agent_api`
   migration + RPC stubs, or (b) static-mock Day Narrative page
   to iterate the visual without blocking on derivers. Argue for
   one.

Don't run `git commit` until Josh confirms the open questions and
your proposed first commit.

## Pointers

- [session-2026-04-27.md](session-2026-04-27.md) — current
  operational reference
- [session-2026-04-28.md](session-2026-04-28.md) — content detector
  + GPS hardening
- [`docs/data-model.md`](../data-model.md) — the contract
- [`docs/dashboard/README.md`](../dashboard/README.md) — long-term
  dashboard design
- [`docs/runtime/rebuild-plan.md`](../runtime/rebuild-plan.md) —
  deriver targets + class hierarchy
- [`docs/concepts/places.md`](../concepts/places.md) — places +
  visit consolidation
- [`docs/concepts/location.md`](../concepts/location.md) — location
  collection spec
