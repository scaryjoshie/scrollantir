# Scrollantir TODO

Living roadmap of everything raised in collaboration with Claude. Status legend:

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

## ✅ This-session shipped (since TODO created)

| Commit | Item |
|---|---|
| 8687106 | Initial TODO file |
| 2c6998f | Caddy zstd + gzip — 102KB → 10KB on chunks payload (-90%) |
| e234e4f | Lazy-fetch project_chunks per visit on click + TopicChunk.project nullable |

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

### Phase F — App icon ingestion (in design)
- Awaiting plan from aff729699e9da939d.
- Goal: lazy-fetched, cached, cheap-on-wire icons attached to `apps.icon` (or sibling table).

---

## ⏳ Open — not yet think-tanked

- **Subcategory auto-detection** — School chunks could auto-tag into class-specific sub-projects (e.g. "STAT 348 lecture" → `school-stat348`). User noted: "this changes pretty frequently, so automating would be optimal."
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
