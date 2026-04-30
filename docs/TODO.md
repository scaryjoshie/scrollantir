# Scrollantir TODO

Living roadmap of everything raised in collaboration with Claude.

**Companion: `docs/TENETS.md`** — durable principles. Read first when in doubt. Status legend:

- ✅ shipped
- 🟢 in progress (code being written)
- 🟡 designed (think tank returned, awaiting implementation)
- ⏳ not yet planned
- 💤 deferred (acknowledged but not soon)
- ❓ open question / undecided

Last updated: 2026-04-30 (mid-session).

---

## ✅ Recently shipped

| Item | Commit | Notes |
|---|---|---|
| GPS noise filtering — three-gate pipeline (LocationWatcher.kt) | 6dd1cad | Accuracy 50m + GPS-attestation + speed-outlier filters |
| Drill-down donut + click bug fix + new layout | 850bf85, 56caf14, 7ed51be | L0 / L1 / L2P / L2C drill |
| Auto-skip rule effective minutes (BLOCKER from audit) | 04d9754 | Phone chunks fully covered by Mac no longer bump project count |
| Map building-highlight race (BLOCKER from audit) | 04d9754 | Cancellation flag in effect cleanup |
| Legend horizontal scrollbar | 04d9754 | `minmax(0, 1fr)` so `truncate` clips package-id-shaped labels |
| Large-arc near-360° SVG fix | 04d9754 | Sweep > 180° splits into two sub-arcs |
| Auto-skip threshold ≤1 → 0 | f6c2749 | Single real project still earns L1 step |

---

## 🟢 In progress

- **Device-pie drill** (paused mid-flight). User asked: clicking the device pie should drill into top apps for that device, with single drill panel below. **Pausing** until the cross-device `app_slug` data layer lands (Phase B+) so we drill on the same canonical app identity as everywhere else.

## 🔄 Rollback policy

Every shipped change in this branch has a documented undo path in the table below. Before merging this branch to main, the policy is:

1. **Commits are atomic** — one logical change per commit. Reverts are precise.
2. **Migrations have explicit `migrate:down`** — even when one-way data loss is unavoidable (e.g. JSONB repointings), the down block restores schema-level state.
3. **Compose / Caddy config edits** are reversible by `git revert` + scp + restart. No data state involved.
4. **Production-touching changes** (DB migrations, runtime/app code rsync) get tracked here BEFORE applying so the rollback recipe is pre-written, not improvised under pressure.
5. **Branch lives durably** — work stays on `donut-drilldown` until full validation; if a phase needs unwinding, branch reset is a clean option.

## ✅ This-session shipped (since TODO created)

| Commit | Item | Rollback |
|---|---|---|
| 2c6998f | Caddy zstd + gzip — 102KB → 10KB chunks payload | `git revert 2c6998f` + scp Caddyfile + restart caddy. |
| e234e4f | Lazy-fetch project_chunks per visit on click | superseded by 34bd573. |
| ebf2e46 | window_session NULLIF for empty-title fallthrough | `git revert` + rsync + restart agent. |
| 5f0c8f8 | Phase B drafts (initial strict-IFF version) | superseded by 854e33d soft model. |
| 34bd573 | lazy-fetch by time window (drops O(N) parent_id query) | `git revert`. Time-window queries against indexed start_ts replace LATERAL parent_id filter; 38ms → 0.18ms. |
| b732ca2 | Sleep render-as-span | `git revert`. Drops the wake Moment, sleep is a kind=sleep TimelineEntry now. |
| 52ba7c9 | Drop unused derived_events_start_desc index | `git revert` then re-CREATE INDEX (migrate:down has the SQL). |
| 854e33d | Phase B revised — soft tree model | drafts only at this commit. |
| 7574cd6 | Project slugs render as curated names via useProjects() | `git revert`. |
| 98cf0be | Unnamed OSM polygons → "Unnamed dormitory" via usePlaceLabels() | `git revert`. |
| 1637cf5 | Friendly leg distance + "Mixed-use" chip | `git revert`. |
| 9599905 | Tracking-gap rows in timeline (30-min threshold) | `git revert`. |
| 76ffd31 | **Phase B EXECUTED** — pre-29 wipe, 0014-0016 applied, classifier rewritten, reclass running | DB rollback: `migrate:down 0016 → 0015 → 0014`. Pre-29 events DELETED — irreversible (per user one-time auth). Classifier code rollback: `git revert 76ffd31` + rsync. Cache TRUNCATE'd — re-runs naturally repopulate. |
| 25ac7a3 | Phase D migration 0018 draft (classifier context schema) | NOT applied. Drafts only. |

---

## 🟡 Designed — awaiting implementation

These have think-tank plans returned. Listed in priority order.

### Phase A — 5-min latency win (✅ shipped, commit 2c6998f)
- **Caddy zstd + gzip enabled.** Verified: 102KB chunks payload → 10KB wire (-90%). br module isn't in the standard Caddy build; zstd + gzip negotiate fine via Accept-Encoding.
- **Real follow-up: lazy-fetch per visit on click** (Task #16). User's deeper point: we shouldn't ship all day's chunks at once. Plan: drop chunks from initial fetch; on visit selection, fetch `?parent_id=eq.<uuid>`. React Query caches per-visit. Prefetch on hover.
- **Synthesis-audit (a555d2e)**: cross-checked 4 plans below — composes cleanly with 7 inconsistencies resolved + 8 gaps surfaced. Hard deps: B → C → E. C.5/D/F.async parallelizable post-C. See audit file for details.

### Phase B — Big-bang: tree model + display names + view slim (🟢 drafted, awaiting downtime window)

**Status update 2026-04-30**:
- ✅ `0014_drop_personal_project.sql` drafted as file
- ✅ `0015_project_chunk_view_harden.sql` drafted as file (coerces category=work + drops redundant per-row project object — 40% wire savings on top of gzip)
- ✅ `classifier.py` prompt rewrite + validator update committed (e234e4f and prior)
- ✅ `window_session.py` `COALESCE(title, app_label, app)` committed
- ✅ Dashboard `TopicChunk.project` nullable + auto-skip generalized — shipped (e234e4f)
- ⏳ Awaiting user-confirmed downtime window to apply migrations + rsync code + restart agent

**Execution playbook (~10 min downtime when user OK's)**:
1. `cd /opt/scrollantir/repo/runtime && sudo docker compose stop agent`
2. SSH-pipe `0014_drop_personal_project.sql` into postgres exec (the `BEGIN/COMMIT` block is atomic).
3. SSH-pipe `0015_project_chunk_view_harden.sql` into postgres exec.
4. `psql -c "TRUNCATE window_titles, classification_queue"` — fresh classifier cache under new prompt.
5. (Optional, since pre-29 already wiped) `DELETE FROM events WHERE start_ts < '2026-04-29' AND received_at < '2026-04-29'` and same for derived_events — confirm with user first.
6. `rsync` runtime/app/src to Hetzner. New `classifier.py` + `window_session.py` go live.
7. `docker compose up -d --no-deps agent` — starts new agent, re-derives + re-classifies fresh.
8. Verify: query a sample of new project_chunk rows; expect (slug + work) or (null + play|neutral) only.
9. Refresh dashboard; verify "scrollantir under Neutral" no longer happens.

**Rollback**: 0014 has `migrate:down` reinserting personal project. 0015 has `migrate:down` restoring 0013's body. Code reverts via `git revert e234e4f`.

This phase fixes:
- "scrollantir under Neutral" (impossible after CHECK constraint)
- Hardcoded `'personal'/'misc'` checks (rule simplifies to `c.project != null`)
- Phone app raw package names ("Messages" instead of `com.google.android.apps.messaging`)
- Wire payload (slim view drops redundant project object)
- Stale 'misc' literal NITs from audit

Sources: a4f5bba (rename), a423b67 (display names), afdfd0f #3 (slim view), a555d2e (synthesis).

### Phase C — Cross-device app identity (`apps` + `app_aliases`)
- New tables: `apps(slug, name, category_hint, icon, is_browser)` + `app_aliases(surface, value, app_slug)`.
- Resolution at deriver time in `window_session/v1`. Auto-bootstrap rules: reverse-DNS for packages/bundles, eTLD+1 for hosts.
- Browser handling: when mac app `is_browser=true`, prefer `mac.zen.tab` event within ±2s for `(title, url_host)`.
- Seed ~30 popular apps so cross-device merge "just works" day 1.
- `app_slug` becomes a peer of `project_slug` on chunks. Source: afaa7ca.

### Phase D — Classifier context enrichment (zen profile + url host + cmux)
- `mac.zen.tab` events captured but deriver ignores. Plumbing zen `container` + `url_host` is biggest disambiguation gain.
- Schema change: `window_titles` + `classification_queue` get `context_key TEXT PK` (hash of title + app + zen_container + url_host).
- Classifier prompt extended with context fields.
- cmux workspace requires native AX code — defer until mac-extension exists.
- Source: ab886e0.

### Phase E — At-a-glance `/summary` view (hierarchical drill)
- Separate `/summary` route + tiny 3-tile teaser strip on `/today`.
- Drill axes: **Day → Category → App → Title → Instances**. Project as second axis ONLY in Work via `[App | Project]` segmented toggle.
- Single drill panel; click any L0 pie/bar (category, device, project, place) drills downstream.
- Headline tiles: Free / Work / Sleep / Phone with vs-prior-period deltas (v1: tile deltas only).
- 5 SQL views/functions for v1 (designs in flight from a9177fe).
- Free time = `awake_minutes − sum(work + neutral effective_minutes)`. Play counts as free.
- Sleep quality = `1 − (disrupted_count / expected_blocks)`.
- **Same `ChunkDrillPanel` component** powers both /today (per-session) and /summary (across-day) — generalized via `axes` prop.
- "Cool effect" animations: scale-in panel transition, slice pulse, fade. Use `framer-motion`.
- Sources: ae62840 (basic design), aa09a38 (hierarchical drill UX), pending a9177fe (SQL views).

### Phase F — App icon ingestion (designed, awaiting impl)
- Plan in (aff7296): base64 in `apps.icon` data URL. Android pushes via one-shot `system.app_icon` event from `UsageStatsPoller` first time package is seen per service run. Server-side hourly `app_icon_backfill` deriver fetches favicons for null icons. Add `icon_source`, `icon_fetched_at`, `icon_fetch_attempts` (cap at 5).
- Mac side blocked on mac-extension foreground watcher existing (gap noted; v1 falls back to category glyph).
- Best-effort, NOT on critical path; runs async post-Phase C.

### Phase G — RETIRED (was: chunk coalesce)
**Originally framed** as a deriver fix to merge "micro-chunks." Investigation showed 78% of chunks are < 30s, median 5.1s — but per user feedback, this reflects their actual heavy alt-tabbing pattern, NOT a deriver bug. Truthful high-frequency data. Coalescing would lossy-compress real signal.

Pieces of original Phase G that were REAL problems and got addressed elsewhere:
- ✅ Empty-title chunks (System Settings rendering blank) — NULLIF fix in `window_session.py` deriver, bundled with Phase B (commit ebf2e46).
- ✅ Wire payload of all-day chunks — gzip (90% off) + lazy-fetch per visit (further drop).
- The donut display is already aggregated by `(project, title)`, so the user never sees 47 raw 5-second slices — just "scrollantir 47m" in the legend. Underlying chunk count is fine.

If row-count grows pathologically (e.g. mac.system.window starts firing every 100ms), revisit. For now, no deriver-level coalesce needed.

---

## ⏳ Open — not yet think-tanked

### 🐞 Active bug — place_visit sync (4/30)

User reported phone-walked at ~3:57 AM but dashboard shows last visit ending 1:01 AM. Investigation:
- Raw events: phone.location.reading from 03:30 → 03:57 AM at coords clearly west of Willard (~870m). User stationary at (42.05189, -87.68114) for ~4 min.
- Deriver tick at 04:40 CT: `stays_detected: 10`, `stays_after_merge: 9`, `rows_after_long_gap_merge: 7`, `stays_pre_window_skipped: 2`. So 9 stays were valid but only 7 emitted.
- LONG-GAP-MERGE collapsed 2 stays incorrectly. The 3:54 AM stay (at non-Willard coords) got merged into the 21:13-01:01 Willard visit.

Likely cause: `_merge_same_place_long_gaps` keys on `place_id`, and the 3:54 AM coords might be matching Willard's polygon via OSM picker (Willard is a large residence; nearby coords could match its building feature). When 12h apart but same `place_id`, the 12h-merge fires and loses the new stay.

Fix candidates:
1. Re-investigate same-place merge: only collapse when there's NO travel_leg evidence in between (the prior synthesis-audit noted this).
2. Tighten the OSM picker's match radius for residential buildings.
3. Add a "stay_centroid distance from prior stay" check before merging.

Real bug; not blocking morning review but should be tracked.

### Data quality cleanup (real findings from earlier in session)
- **Norris Center duplicate place rows** — two rows <2m apart for the same building. Flagged in the data-quality audit; never resolved. Need a dedupe pass on `places` keyed by (lat, lng, name) within ~5m radius.
- **Unnamed OSM places** (`building:275854338`, etc.) — INVESTIGATED 2026-04-30, NOT a deletion candidate. They're real Northwestern buildings whose Mapbox features have polygon + type (parking/dormitory/university) but no public name. 3 such rows total, 0 references in derived_events. Created during the 4/29 OSM picker iteration but never retained as visit ancestors. Better fix: dashboard renders them with a category-aware fallback label ("Unnamed dormitory") when encountered, instead of `building:NNN`. Don't delete.
- **Phone tracking blackouts** — observed 11.5h dark window on 4/29 (03:49 → 15:25 CT) that masked actual sleep. Phone-side root cause unknown — Doze mode? Permission revoked? Service killed? Needs Android-side investigation by user. Non-trivial reliability issue.
- **GPS attestation gate over-aggressive on indoor↔outdoor transitions** — caused the 12-min Blom→Plex gap. The three-gate filter (commit 6dd1cad) drops fixes the user knows are real, near building entrances. May need to allow lower-quality fixes during activity transitions.

### Patches-without-understanding sweep (queued post-Phase-B)
From audit (a4c976) 2026-04-30 + verifying queries:
- **Drop `'personal'/'misc'` string guards** in `DetailPane.tsx` (3 sites) — dies post-Phase-B.
- **Drop view-level COALESCE for `places.category`** — verified never NULL in practice (0/14 rows).
- **Re-evaluate `activity → 'walking'` fallback** in `travel_leg.py:140-148` — once we have vehicle / cycle data (current 8/8 legs are walking; can't distinguish fallback firing from real).
- **Drop dead branches** — `len(durations) <= 1` (only ==1 reachable), `if span_start >= end: continue` after lookback fetch, `try { setFeatureState } catch` (Mapbox v3+ stable).
- **Don't drop yet — needs more data** — sleep `disrupted_count` heuristic + `confidence /2.0` factor (1 sleep row so far; let week accumulate).
- **Surface unread metrics** — `osm_errors`, `activity_unknown_legs`, `spans_skipped_pre_window` are emitted but nothing reads them. Pipe one to console log so we can audit fallback firings.

### Other open items
- **Subcategory auto-detection** — School chunks could auto-tag into class-specific sub-projects (e.g. "STAT 348 lecture" → `school-stat348`). User noted: "this changes pretty frequently, so automating would be optimal."
- **Android `getClassName()` spike** — could disambiguate within-app screens (Slack channel list vs DM, Messages contact vs convo). Surfaced by the 2026-04-30 empty-title investigation. Currently we use `app_label` ("Slack") only; class name might give richer signal at near-zero ingest cost.
- **`ContentDetectorService` extension** — already runs on Android for Reels detection. Has full accessibility tree access; could optionally extract URL bars / message thread names / search query text. Privacy-sensitive — defer until clearly needed.
- **Document the `_collapse_overlaps` and "hold the tail" disciplines in mac-forwarder** — they paper over aw-server quirks that future maintainers (or post-AW migrations) will hit. Add comment explaining the upstream behavior.
- **Single-command Docker deploy** — user's stated long-term goal: "ideally deployed with docker in like 1 command."
- **TZ-aware deriver thresholds** — sleep deriver hardcoded `America/Chicago`; breaks when traveling.
- **Per-user tunable thresholds** — sleep `night_floor_min`, gap settings, etc. currently class attributes; should live in a settings table once we move past v1.
- **`/projects` CRUD + manual classification override** — dashboard page to add/edit/archive projects + override misclassifications. Mentioned but never planned.
- **env_file: instead of explicit per-key in compose** — user disliked the explicit listing. Pattern (2) from earlier: load entire `.env` automatically.
- **Edge proxy near Chicago** — Cloudflare or regional Caddy. Real fix for transatlantic latency once gzip wins are exhausted. Source: latency plan #6.
- **Dashboard tests** — zero today. Audit flagged as a structural gap.
- **OSM picker tests** — `_pick_best_feature` untested; the Blomquist→Statistics regression would still pass. Audit (final).
- **`_merge_same_place_long_gaps` tests** — untested AND structurally vulnerable to swallowing real walks across blackouts (the user's 3 AM walk case).
- **`replace_derived_overlap` RPC tests** — only stub-fetch tests exercise the framework.

---

## 🚨 P0 — `parent_id=eq.<uuid>` is O(N²) (regression from commit e234e4f)

The lazy-fetch I just shipped relies on `?parent_id=eq.<uuid>` against `v_project_chunk_today`. The view computes `parent_id` via a LATERAL join; filtering by parent_id requires computing it for every row first. **38ms today, growing quadratically.**

Fix: materialize `parent_id` into `data` at write time in `project_chunk.py`, add JSONB partial index, drop the LATERAL from the view. Bundle with Phase B since both touch project_chunk.

## 🔴 PHASE B INVERSION — tree-model strict-IFF was wrong

The agent (a042036) found 67 `neutral+project` and 27 `play+project` rows in the live cache — the strict IFF was always fiction. User pushed back on the strictness too. New direction:

- **Decouple `project_slug` from `category`.** Allow `(scrollantir, neutral)` for project-adjacent admin. Allow `(personal_project, work)` for "learning guitar is focused effort."
- **Don't ship the CHECK constraint** in 0014 (it would invalidate 94 existing live rows).
- **Add `projects.default_category`** — each project carries its presumed flavor. Soft binding, not structural.
- **Drop the `_parse_response` reconcile step** at classifier.py:247 — was masking the real model.
- **Drop `personal` from the classifier's project list entirely.** Don't pass it; let `project_slug=null` be the answer for non-project chunks. (Honest representation.)

**Phase B drafts (0014, 0015, classifier.py) need rework before applying.** The current drafts assume strict IFF. New plan:
- 0014 just deletes the personal project (no CHECK constraint). FK cascade pre-emptively NULLs window_titles.project_slug='personal' refs.
- 0015 view stays but drops the category coercion (no longer needed; whatever the classifier emits is the truth).
- classifier.py drops `personal` from the project list, drops the reconcile step, splits coerce-vs-raise per Tenet 2.

## 🟡 User-confirmed direction (2026-04-30)

These reflect the user's explicit guidance from the architecture + UX conversation; they're priority direction-setters even if not yet ticketed work.

- **Sleep should render as a span on the timeline, not just a Moment.** The deriver already produces a span `[onset, wake]` — the dashboard is collapsing it to a wake-time icon. Surface the duration. UX work, not deriver work.
- **Classifier prompt + context completeness is high-priority.** User: "are the prompts actually good? Are we passing all the information that the agent needs?" Currently we pass: (title, active projects). We have but DON'T pass: device, app, zen container, url host, prior-chunk context. Phase D (classifier context, ab886e0) addresses this — bump up priority.
- **Tree-model invariant is too strict.** Should allow personal projects that are non-work (learning guitar, hobby coding). Replace `project_slug != null IFF category = 'work'` with a softer model: a project has a default category but chunks can override. **Re-think Phase B's CHECK constraint** — see new tenet on never-discarding-data.
- **At-a-glance is the answer for "how was my day."** Multiple sub-views (today summary, trends, comparisons). Not just one page.
- **Drop the priority of a "manual correction" UI.** User: "I would not worry about correction right now. I would just worry about... are the prompts actually good?"
- **Map: keep but don't over-invest.** It's visual flavor, not load-bearing.
- **Per-task hierarchy (project → task → titles) is over-engineering for v1.** Defer.
- **Multi-device adapter abstraction: nice-to-have only.** Single user for now.
- **Indexes on `derived_events` need review** — big shared table is OK if indexed for the queries we actually run.
- **Brainstorm new derived tables** that would unlock new questions.

## ❓ Open questions / undecided

- Project axis interplay with app axis at L1 in /summary — segmented toggle works; should it also exist on /today's per-session drill where Work has multiple projects?
- Animation library — `framer-motion` (~30KB) for the cool drill transitions; is the bundle bloat OK?
- Comparison-mode (vs yesterday / last week) — tile deltas in v1, per-row deltas in v2. Confirm scope.
- Mobile/narrow-screen — desktop-only for v1, mobile sheet for v2. Confirm or accept.
- Custom date range picker — defer to v2.

---

## 💤 Deferred (explicit)

- **Sunburst / concentric rings layout** — user asked, then accepted that click-to-zoom (current implementation) was better than concentric for >50 titles per project. Decision recorded.
- **Phone-side LocationWatcher → `LocationManager.GPS_PROVIDER` directly** — user's domain (Android), pending.
- **Phone-side 10s GPS interval when walking/cycling/driving** — user's domain, pending.
- **Server-side median-3 path smoother** — phone-side fixes are higher ROI per location audit.
- **Skip-pre-window cleanup in user_active + place_visit** — defensive code now redundant under `OVERLAP_REPLACE`. Safe to remove later.
- **Long-visit-beyond-lookback BLOCKERs (>32h visits)** — edge case, won't bite for typical use.

---

## Open process points

- User said "make your own decisions and implement, as long as you audit thoroughly enough." Bias toward shipping after audits ground the plans.
- User said "feel free to completely reprocess the LLM stuff if you need" + "reset all data that's before the 29th" — license to do clean-slate operations during Phase B/C.
- User said "I won't touch hetzner" — deploy ops stay on the orchestrator side.
- Recurring user preferences: terse responses, no clutter, fewer hardcoded edge cases, general systems over patches, durable code over vibe-coded.
