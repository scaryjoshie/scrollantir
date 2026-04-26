# Session 2026-04-23 — the mac-forwarder truncation bug

Investigation + plan, written before any code change. No commits
landed from this session; the dashboard has a handful of staged but
unapplied dashboard-side changes that must be re-evaluated after the
forwarder fix (see "Dashboard change audit" below).

## TL;DR

- **93% of Mac activity is missing in Supabase.** Last 24h, AW
  locally reported 23.87 hours of window coverage; Supabase has
  1.61 hours. Forwarder is snapshotting events mid-heartbeat and
  advancing past them, freezing durations at the snapshot value.
- **Fix is a small, localized change** in
  `mac-forwarder/forwarder.py` — hold the newest event per bucket
  instead of forwarding it, ship it only once a newer-id sibling
  has appeared and sealed its duration.
- **Our own "derived idle" model is actually worse than AW AFK.**
  Empirically, it over-counts active time by treating
  laptop-left-open-unattended as active (7.5-hour sleep span
  labeled active yesterday). AW AFK is the better primary signal;
  we should switch to AFK-based with phone-foreground union.
- **Do nothing else until the forwarder is fixed.** Every downstream
  metric is unreliable until durations are real.

## The bug

### Symptom

Josh said "I was on the computer for hours" but the dashboard showed
17 minutes of Mac activity. Pulled the raw data, found the 93% loss
number:

| window | AW local | Supabase | loss |
|---|---|---|---|
| 25-min sample | 1489.5s | 270s | 82% |
| **24 h** | **23.87 h** | **1.61 h** | **93.3%** |

Cross-checked a specific 5-minute gap where the dashboard showed
nothing. AW local had the events (a 330.9-second cmux session
starting 20:10:46 CT); Supabase had the same event at `duration=18s`.
Same id, same timestamp, truncated duration.

The AFK watcher looked *less* broken than the window watcher because
AFK state changes are fewer and longer-lived, so the forwarder has
fewer chances to catch an event mid-growth. Both have the same bug.

### Root cause

AW window events **grow in duration** via heartbeat. Same event id,
growing `duration_s`. When focus changes, a new event with a new id
is created; the previous event's duration is now frozen.

`drain_bucket` in `mac-forwarder/forwarder.py:342`:

```python
aw_events = aw.get_events(bucket_id, start=last_ts, limit=-1)
fresh = sorted((e for e in aw_events if e.id > last_id), key=lambda e: e.id)
# … collapse cascade, POST, advance checkpoint past fresh[-1].id …
```

It ships whatever durations the tail event has at snapshot time, then
advances `last_id` past it. On the next poll, any further growth is
filtered out by the `e.id > last_id` guard. The final duration never
lands.

The existing `_collapse_overlaps` is correct logic but gets starved
of the data it needs — each poll only contains one heartbeat row for
the active focus period, so there's nothing to collapse against.

## The fix

### One-line rule

**Never forward the newest event in a bucket. Re-read it next poll.**
It's forwarded only once a newer-id sibling event exists, confirming
the previous event's duration is frozen.

Under this rule, `_collapse_overlaps` sees the full cascade over
consecutive polls (because checkpoint stays below the tail id until
the tail is sealed), correctly picks the longest survivor, and
forwards exactly one row per focus period with its final duration.

### Diff sketch (prose, not applied)

In `drain_bucket`:

1. Early-return on empty `fresh` (unchanged).
2. After `_collapse_overlaps`, split survivors: `tail = survivors[-1]; to_forward = survivors[:-1]`.
3. If `to_forward` is empty, return with checkpoint id held at
   `max(cp["id"], tail.id - 1)` and ts at `iso_z(tail.timestamp)`.
   No POST this run.
4. Otherwise POST `to_forward` as today.
5. New checkpoint `{"id": tail.id - 1, "ts": iso_z(min(tail.timestamp, max(e.timestamp for e in to_forward)))}`.
   The `min(...)` guards against the backward-stepping cascade
   timestamps already documented in the existing collapse comment.
6. Drop the `original_max_id` / `original_max_ts` capture and the
   assert — no longer needed.

Net: ~15 lines edited, no new top-level symbols, no new config, no
ingest-side changes. Checkpoint file format unchanged.

### Cost of this model

The currently-focused window does not appear in Supabase until focus
changes. For a dashboard about *what happened* this is fine. For
*what's happening right now* the dashboard can query AW-local
(`http://localhost:5600`) directly since both run on Josh's Mac.

### Edge case not being solved today

If AW dies, or the laptop goes to sleep with a window still focused,
that window's event never gets a newer sibling — it stays held
indefinitely. When AW resumes or the Mac wakes, a new focus event
eventually appears and the held one ships. Max data loss: the
seconds between "last heartbeat before sleep" and "now."

A future safety valve would force-forward a tail whose
`timestamp + duration < now - 5 min` on the assumption it's
genuinely frozen. Punt until this becomes a real problem.

## Dashboard change audit

A handful of dashboard-side changes are staged but not committed
from earlier this session. Each needs re-evaluation once correct
data flows:

| Change | Status | Reasoning |
|---|---|---|
| `EXCLUDED_MAC_APPS` adds `coreautha`, `CoreServicesUIAgent`, `Passwords Extension Helper (Zen)` | **Keep** | Lock/auth-prompt apps; not real presence regardless of duration. |
| `system.afk` filter to `status=afk` only | **Keep** | `not-afk` rows describe active spans; they were wrongly counted as AFK. Bug regardless of truncation. |
| Drop `zen.tab` from `MAC_FOCUS_SOURCES` | **Keep** | `system.window` already captures "Zen was focused"; `zen.tab` is tab-level detail. |
| Drop `duration_s == 0` focus events | **Keep** | Genuine transition markers in any data. |
| `FLICKER_THRESHOLD_S = 2` | **Revisit** | Papered over truncation. Once durations are real, drop to 0 or 1s. |
| Idle bounds clipped to `now` | **Keep** | Correctness bug orthogonal to forwarding. |
| Hide `phone.location.reading` by default | **Keep** | Awaiting derivation layer. |
| Derived-idle model (`server/idle.ts`) | **Replace** (see next section) | Empirically worse than AW AFK on real data. |

## AFK model decision

### Empirical comparison

Pulled AW local + Supabase phone data for last 24h and compared two
models of "active":

| Model | Active | Idle |
|---|---|---|
| `mac_focus ∪ phone_fg` (what we built) | 23.68 h | 0.14 h |
| `aw_not_afk ∪ phone_fg` (AW AFK + phone) | 7.78 h | 16.22 h |
| `(focus ∩ not-afk) ∪ phone_fg` (hybrid) | 7.52 h | 16.30 h |

Our model's "16.16 h active that AW-based misses" includes the
**02:13–09:47 7.5-hour block** that is obviously sleep. The laptop
was left open with a window focused; window events kept heartbeating
while Josh was asleep. AW's input-based AFK correctly caught it; our
focus-based model didn't.

Hybrid added zero hours beyond AW-based because `not-afk ⊆ focus` in
practice — to type or click, something has to be focused. No
passive-but-present signal exists in the current data to layer on.

### Decision

**Switch to AW-AFK as primary, union with phone foreground.**

```
mac_active_ms = total(aw_not_afk clipped to window)
active_coverage = aw_not_afk ∪ phone_fg
idle = gaps in active_coverage ≥ 2 min
```

Known limitation: under-counts passive consumption (watching a video
on the laptop with no input). Acknowledged and labeled clearly in
the UI.

### Rejected alternatives

- **Our own focus-based idle model.** Fails on the sleeping-laptop
  case. Documented above.
- **Hybrid focus ∩ not-afk.** Adds nothing beyond plain AW AFK in
  current data.
- **Raising the 2-min idle threshold.** Doesn't help — the problem
  is the signal, not the threshold.

### Future media signal

The `audible` flag on `zen.tab` is collected but under-populated by
the extension: last 48h had 11 `audible=true` events, all from a
single Google Meet standup. No YouTube, Spotify, or video playback
is flagged. Either the `aw-watcher-web-firefox` extension only reads
`audible` for WebRTC, or the Firefox tab API isn't exposing it
consistently. Not usable as a presence signal today.

Two upstream paths if/when we want "listening to media = present":

- **`nowplaying-cli` watcher** — reads `MPNowPlayingInfoCenter`
  (system-wide media state) and emits a `mac.media.playing` source.
  One new launchd collector, ~50 lines. Catches Spotify, Apple
  Music, Netflix app, YouTube in any browser, any app producing
  media. Best signal.
- **Fix the extension** — teach `aw-watcher-web-firefox` to read
  `tab.audible` correctly for media tabs. Narrower scope (browser
  only).

Prefer `nowplaying-cli` when we pick this up. Defer until the
AFK-based model is in place and we see what it misses.

### AFK timeout tuning

AW's AFK threshold defaults to 180 seconds. Josh said his usage
pattern is "at least one keyboard/mouse interaction every 15
minutes when active." Raising AW's AFK timeout to 600–900 seconds
(10–15 min) on his Mac would better match that pattern —
reading-without-typing spans up to the threshold count as active;
longer-than-threshold gaps still catch sleep and genuine absence.

Config lives in `~/.config/activitywatch/aw-watcher-afk/aw-watcher-afk.toml`
on Josh's machine:

```toml
[aw-watcher-afk]
timeout = 600.0
```

One-line change; complements the dashboard-side model switch.

## Implementation plan

Order matters here. Each step depends on the prior:

1. **Fix the mac forwarder** (hold-the-tail).
   - Single-file change to `mac-forwarder/forwarder.py`.
   - Josh applies; agent wrote the spec above.
   - No dashboard, schema, or ingest changes required.
2. **Optional: tune AW AFK timeout** to 600–900s in Josh's AW config.
3. **Let 24 hours of correct data flow.**
4. **Dashboard model switch**:
   - Update `server/summarize.ts` so `mac_active = aw_not_afk`
     (clipped to window).
   - `active_coverage = aw_not_afk ∪ phone_fg`.
   - `idle = gaps in active_coverage ≥ 2 min`.
   - `server/idle.ts` can stay as the gap-computation utility; the
     *inputs* change.
5. **Drop `FLICKER_THRESHOLD_S`** (or lower to 0/1s) once real
   durations are in.
6. **Relabel Summary UI** — "Mac (actively using)" or similar, with
   a small note that it measures input-active time. Remove the
   "AW AFK (ignored)" card; keep `mac_afk_ms` as a debug field only.
7. **Validate against Josh's lived experience** for a representative
   day — same loop we should have been running all along.

## Reset + replay path (Option C from session discussion)

Chosen: wipe truncated mac events + existing reports, let the fixed
forwarder replay from AW-local, regenerate reports on the
orchestrator. Automated (minus the orchestrator step) via
`mac-forwarder/reset-and-replay.sh`.

The script is dry-run by default and requires `DATABASE_URL` set to
a `service_role` DSN. With `--execute` and explicit "yes"
confirmation it:

1. `launchctl unload` the forwarder
2. `DELETE FROM public.events WHERE device='mac' AND source IN (window/afk/zen.tab)` + the stray `test.curl` row
3. `DELETE FROM public.reports` (hard delete — relies on orchestrator to regenerate)
4. `rm ~/.scrollantir/checkpoint.json`
5. `launchctl load` the forwarder

The forwarder, with no checkpoint, scans each AW bucket from epoch
and starts shipping sealed events. Replay typically completes in
5–10 minutes (batches of 500, 30s interval).

Orchestrator re-triggering is manual: SSH to Hetzner and either
wait for the next cron tick (07:00 CT daily, Sun 09:00 CT weekly)
or invoke the job prompts under `/scrollantir/jobs/` manually via
`claude -p`.

## Open questions

1. **Backfill truncated historical data?** Answered by Option C —
   replay from AW-local after wipe. Script handles the mac side;
   orchestrator regeneration is manual.
2. **Ingest upsert support?** The hold-the-tail fix makes this
   unnecessary (each AW row lands exactly once, with final
   duration). But an upsert path would be useful for any future
   "live update" use case. Not a near-term need.
3. **Passive-media detection?** Deferred to `nowplaying-cli`
   watcher when we build it. Interim: raise AFK timeout.
4. **Tail-stuck edge case.** If tail never seals (watcher death,
   laptop sleep with focus stuck), we lose sub-heartbeat tail
   seconds. Acceptable for now; force-seal rule is a future
   enhancement.

## Pointers

- Forwarder code: `mac-forwarder/forwarder.py`; the `drain_bucket`
  function at line 342 is the only function that needs changing.
- Mac collection spec: `docs/mac.md` (describes the forwarder's
  intended behavior; the bug is in implementation, not spec).
- Dashboard central logic: `dashboard/server/` (summarize, blocks,
  idle, labels). This is where the AFK-based model lands in step 4.
- Earlier session chronicle: `docs/session-2026-04-21.md`
  (first end-to-end day).
