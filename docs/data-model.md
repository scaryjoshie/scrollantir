# Data model — primitives, derivers, views

Foundation document for how scrollantir represents data and processes
it from collector → dashboard. This is the contract every component
(collectors, forwarders, derivers, UI) should read from and write to.

## What's in scope

- The two-table event model (raw + derived) and the invariants each table holds
- The catalog of **primitives** (raw event sources currently emitted or planned)
- The **deriver** class hierarchy and when to use each type
- The registry of **derivations** (which deriver produces which derived kind)
- The catalog of **views** the dashboard reads

## What's not

- Ingest HTTP contracts (see `edge-functions.md`)
- Credentials and role model (see `data-flow.md`)
- Per-device collection specifics (see `android.md`, `mac.md`)
- UI styling / layout (evolving in `dashboard.md`)

---

## 1. Event model

Two tables. Separate contracts. The split is deliberate — they hold
qualitatively different things.

### Observer-stream principle (raw events)

Every raw event is **one observer reporting one thing it locally
saw**, with whatever context that observer happens to know at emit
time. Observers are independent: their streams overlap freely in
time, and that overlap *is* the relation. Cross-stream facts are
computed by derivers; the events table never carries parent/child
references between rows.

The corollary: prefer many narrow, brain-dead-simple sources over
fewer rich ones with embedded structure. A new collector adds a
`(source, data)` shape and emits whenever its observation pattern
fires. All judgment about what the data *means* lives in the
deriver layer where it's replayable, versioned, and debugged in one
place.

Concretely: if you can tell what a row means by looking only at it
plus its source's documented `data` shape, the model is working.
If you have to consult other rows to interpret it, push that work
into a deriver.

When emit-time observes a structural ID (cmux session_id, calendar
event_id, spotify playlist_id), include it as a field in `data` —
not as a structural relation between rows. It's a hint a deriver
can use, not a parent-child link.

### `public.events` — raw, immutable, collector-written

Collector-produced data points. One row per local observation.
Once ingested, a row never changes. Retries produce the same UUID
(deterministic generation per observation), so re-sends are no-ops.

```sql
CREATE TABLE public.events (
  id          UUID PRIMARY KEY,
  source      TEXT NOT NULL,                           -- 'mac.system.window', 'cloud.github.commit'
  device      TEXT GENERATED ALWAYS AS                 -- first dotted segment of source
                  (split_part(source, '.', 1)) STORED,
  start_ts    TIMESTAMPTZ NOT NULL,                    -- when the observation started (UTC)
  end_ts      TIMESTAMPTZ NOT NULL,                    -- = start_ts for point events
  duration_s  DOUBLE PRECISION GENERATED ALWAYS AS
                  (EXTRACT(EPOCH FROM (end_ts - start_ts))) STORED,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),      -- forensic: when ingest accepted the row
  CHECK (end_ts >= start_ts),
  CHECK (source ~ '^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$')
);
```

**Source naming.** Always `<device>.<namespace>.<specifier>`. The
`device` column is a generated projection of the first segment,
indexable and FKable to `public.devices`.

- Physical hosts: `mac.system.window`, `phone.youtube.shorts`,
  `phone.location.reading`.
- Services / cloud-polled: `cloud.github.commit`,
  `cloud.spotify.track`, `cloud.gcal.event`. `cloud` is a synthetic
  device representing service-polled events emitted by the
  orchestrator. It lives in `public.devices` with a `kind = 'service'`
  row alongside `kind = 'physical'` rows for mac/phone.

**Time model.** `(start_ts, end_ts)` is the canonical span.
`duration_s` is generated for aggregation ergonomics (`SUM(duration_s)`
stays clean). Point events have `end_ts = start_ts`. The wire
format keeps `(start_ts, duration_s)` for collector simplicity
(matches what AW and the phone Room queue emit); the edge function
computes `end_ts = start_ts + duration_s * INTERVAL '1 second'` at
insert time.

**Invariants.**
- Only collectors (via `ingest_role` through the edge function) write here.
- No UPDATE. No DELETE except for admin reset. Append-only.
- `id` is deterministic per source observation. The same underlying
  observation produces the same UUID across retries; this is what
  makes `ON CONFLICT (id) DO NOTHING` safe.
  - **Mac**: `uuid5(NAMESPACE_URL, "mac:{source}:{bucket_created_at}:{aw_event.id}")`.
    Hostname-agnostic. See `mac-forwarder/forwarder.py`.
  - **Phone**: client-generated UUID stored in the local Room queue
    before forwarding. Stable across forwarder retries.
  - **Bucket rebuild caveat**: when AW rebuilds its bucket (DB wipe),
    `bucket_created_at` changes and the UUID generation produces a
    new generation of IDs that intentionally don't collide with the
    old. This is the right behavior — the underlying observations
    are now coming from a fresh bucket.
- `start_ts` is the wall-clock time the observation began (UTC),
  not the ingest time. `received_at` is the distinct "when did we
  learn about it" timestamp — kept for forensics (forwarder
  diagnostics, late-arriving data investigations).
- `source` is never re-interpreted. New taxonomy = new sources;
  old rows keep their original source value.
- The edge function authoritatively validates the source prefix
  against the bearer token's device — events whose source prefix
  doesn't match the token's device (or `cloud.` for the
  orchestrator) are rejected.

### `public.derived_events` — computed, append-only

Products of derivers. One row per derived span (sleep, session,
visit, etc.). Never contains *speculative* values — a row exists
only if we stand behind it under one of the deriver-class rules
(see §3). In short: deterministic derivers stand behind their own
algorithm; LLM derivers stand behind either a high-confidence
proposal *or* a user confirmation. Heuristic guesses below their
threshold never persist; they live in prompt `ctx` or are computed
on read only.

```sql
CREATE TABLE public.derived_events (
  id          UUID PRIMARY KEY,
  source      TEXT NOT NULL,                           -- '<kind>/<version>', e.g. 'sleep/v1'
  start_ts    TIMESTAMPTZ NOT NULL,
  end_ts      TIMESTAMPTZ NOT NULL,
  duration_s  DOUBLE PRECISION GENERATED ALWAYS AS
                  (EXTRACT(EPOCH FROM (end_ts - start_ts))) STORED,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance  JSONB NOT NULL,                          -- audit trail; see below
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_ts >= start_ts)
);
```

**Source format for derivations** is `<kind>/<version>` — a slash,
intentionally distinct from raw events' dotted form. A glance at
a `source` value tells you which table the row belongs to, and
the `device` projection doesn't apply (derivations are logical
computations, not device-bound observations). Device-keyed
derivations bake the device into the kind: `mac_active/v1`,
`phone_active/v1`, etc.

The replace-window rule (§4) keys directly on `source` — no
JSON-path scan needed.

**Invariants.**
- **The DB stores only rows we stand behind.** Specifically:
  - Deterministic derivers' outputs (algorithm = ground truth).
  - LLM derivers' outputs that meet their `confirmation_policy`:
    `'always'` → only after user confirmation; `'if_uncertain'` →
    high-confidence proposals OR user-confirmed lower-confidence
    proposals; `'never'` → degenerate to deterministic-style auto-
    insert (use sparingly; if you find yourself reaching for this,
    the deriver is probably actually Deterministic).
  - **No row is ever inserted as a "speculative guess pending review."**
- Append-only. Corrections are delete-then-insert through the agent's
  confirmation flow — never naked UPDATE.
- `provenance` describes how the row came to exist:
  ```json
  {
    "inputs": ["mac.system.afk", "phone.system.unlocked"],
    "source_event_ids": ["..."],
    "confirmation": { "prompt_id": "...", "answer_event_id": "..." } | null
  }
  ```
  For deterministic derivers `confirmation` is `null`. For LLM
  derivers it names the prompt + answer that produced the row.
  The deriver name + version live in the `source` column;
  `provenance` is the audit trail of inputs and confirmations.
- Authorship is inferable without a `created_by` column: the deriver
  registry says where each `source` runs (orchestrator / dashboard);
  user-confirmed rows have `provenance.confirmation` populated.

### Why two tables (vs. one with a `layer` column)

- Raw is immutable with deterministic IDs; derived is append-only
  with replace-window-by-source semantics. Contracts don't unify
  cleanly.
- Different write authorities. `ingest_role` writes raw; `agent_role`
  writes derived. Cleaner RLS.
- Rebuilding all derived data doesn't touch raw.
- Source-format convention (`<device>.<n>.<n>` for raw,
  `<kind>/<version>` for derived) makes table-of-origin obvious from
  a row alone.

### Corollary: heuristics displayed but not persisted

**Dashboard views may show heuristic numbers, but only computed on
read, never persisted.** If the dashboard wants to render "probable
sleep 11pm–7am (unconfirmed)," the compute happens at query time
and the UI shows a visible "unconfirmed" marker.

The persisted-vs-displayed distinction:
- A `'always'`-policy LLM deriver renders an unconfirmed proposal
  on the dashboard while waiting for the user's answer; only a
  positive answer materializes a row.
- A `'if_uncertain'`-policy LLM deriver renders nothing extra
  pre-insert: above threshold the row exists; below threshold the
  user is being asked and the dashboard waits.
- Deterministic derivers always have rows present (or compute on
  read for aggregates).

---

## 2. Primitives catalog

Every **raw source** that currently lands in `public.events`, or is
planned to. This is the input alphabet for everything downstream.

### Mac (collector: ActivityWatch → mac-forwarder)

| source          | data                                                          | emission                                                            | reliability | caveats |
|-----------------|---------------------------------------------------------------|---------------------------------------------------------------------|-------------|---------|
| `system.window` | `{app, title}`                                                | aw-watcher-window heartbeats; one sealed event per focus period     | high*       | Fires as `app='loginwindow'` during lock screen; excluded from active attribution. 62% of events are sub-3s focus flickers — filter at derivation layer, not here. |
| `system.afk`    | `{status: 'afk' \| 'not-afk'}`                                | aw-watcher-afk; 180s idle threshold to flip to `afk`; retroactive timestamps | high        | Under-counts passive consumption (video watching = `afk` if no input). Both `afk` and `not-afk` statuses are emitted; only `status='afk'` spans represent actual AFK. |
| `zen.tab`       | `{url, title, container, audible, incognito}`                 | forked aw-watcher-web-firefox; emits per-tab focus within Zen       | medium      | `audible` appears under-populated (only fires for WebRTC, not YouTube/Spotify). Orphan events fire when Zen isn't the focused app (~1% of rows). Do NOT use as a Mac-focus signal — `system.window` already captures that. |

\*`system.window` was previously `low` due to the 93% duration loss
from the mac-forwarder bug (see `session-2026-04-23-aw-forwarder.md`).
Fixed 2026-04-23 with hold-the-tail semantics.

### Phone (collector: Android tracker service → ForwarderWorker)

| source                   | data                                                | emission                                              | reliability | caveats |
|--------------------------|-----------------------------------------------------|-------------------------------------------------------|-------------|---------|
| `system.foreground`      | `{app, package}`                                    | on foreground-app change via UsageStats               | high        | Pixel launcher inflates ("home screen visible"); dashboard should downweight launcher in per-app totals. |
| `system.screen`          | `{state: 'on'}`                                     | on screen-on, with duration of on-span                | high        | Absence = screen off. |
| `system.unlock`          | `{}`                                                | point event on unlock                                 | high        | Duration always 0; paired with `system.unlocked` span. |
| `system.unlocked`        | `{}`                                                | duration = span between unlock and lock               | high        | Pairs with a prior `system.unlock` point event. |
| `youtube.shorts`         | `{}`                                                | accessibility-service content detector               | medium      | Fires only while the Shorts player has the matching view-ID layout; some false negatives. |
| `instagram.reels`        | `{}`                                                | accessibility-service content detector               | medium      | Same limitations as `youtube.shorts`. |
| `tiktok.feed`            | `{}`                                                | accessibility-service content detector               | medium      | Same. |
| `instagram.stories`      | `{}`                                                | accessibility-service content detector               | medium      | Same. |
| `detector.miss`          | `{package, view_ids}`                               | 0-duration diagnostic; rate-limited 1/60s per package | —           | Not user-facing. Filter out by default. Useful for classifier development. |
| `phone.location.reading` | `{lat, lng, accuracy_m, provider, reason}`          | fused-provider polls; 0-duration point events          | medium      | Raw pings; do not render directly — consume via `VisitDeriver` (future). |
| `phone.activity.state`   | `{state: 'still'\|'walking'\|…}`                    | fused activity-recognition API; state-change events   | medium      | Android's own classification; treat confidence as inherent. |

### Prompt-answer pseudo-sources

When the user answers an agent-authored prompt (`agent_api.create_prompt`
→ phone's prompt inbox → `prompt-answer` edge function), the answer
lands as a regular event with:

| source                       | data                                                   | notes |
|------------------------------|--------------------------------------------------------|-------|
| `prompt.<kind>`              | schema defined per prompt kind (see `agent_api`)       | Kinds: `prompt.sleep_confirmation`, `prompt.project_attribution`, etc. |

These are collected raw events same as any other — the user is just
another collector. LLM derivers reference these in their provenance.

### Non-primitives (do NOT treat as such)

- **Aggregate totals** ("hours on cmux today") are not primitives.
  They're computed on read from raw + derived.
- **Derivation outputs** (sleep span, session, visit) are not
  primitives. They live in `derived_events`.

### Adding a new primitive

1. Pick a `device` and `source` string; document schema and emission
   pattern in the table above.
2. Wire up the collector to emit it through the existing ingest path.
3. If it's collected from a user prompt, declare the kind in
   `agent_api.create_prompt` and the phone answer-rendering side.
4. No migration needed — `public.events` already accepts arbitrary
   sources; the JSONB payload absorbs schema variation.

---

## 3. Deriver hierarchy

Every derivation is a class with a well-defined contract. Two
direct subclasses today; third may appear if a use case demands it.

```
Deriver (abstract)
  ├─ DeterministicDeriver       — pure function of inputs
  └─ LLMDeriver                 — propose + (optionally) confirm
```

### `Deriver` (base)

```
source:            string            // '<kind>/<version>', e.g. 'sleep/v1'
                                     //   doubles as the value written to
                                     //   derived_events.source and the
                                     //   replace-window key
inputs:            string[]          // raw sources ('mac.system.afk') or other
                                     //   derivers ('derived.mac_active')
persistence:       'stored' | 'on_read'
cadence:           string | object   // cron schedule, 'on_demand', or 'on_event'
```

Bumping the version suffix (e.g. `sleep/v1` → `sleep/v2`) makes the new
run produce rows under a new source. Replace-window scope is per-source,
so old `sleep/v1` rows are untouched until explicitly deleted — clean
A/B comparison and rollback.

### `DeterministicDeriver`

Pure function of inputs. Same inputs → same outputs, always. Runs on
a schedule or on demand. Writes directly to `derived_events` (if
`persistence = 'stored'`) or produces computed values (if `'on_read'`).

Additional contract:
```
run(window: Span): DerivedEvent[]
```

Never asks. Confidence is implicit in the algorithm. If the algorithm
produces ambiguous results, that's a bug in the algorithm, not a user
question.

### `LLMDeriver`

Proposes a derivation and, when uncertain, asks the user to confirm
before writing. Owns the **complete cycle** for its derivations —
forward computation, prompt creation when uncertain, and completion
when an answer arrives. No client (phone, dashboard) ever inserts
directly into `derived_events`; every materialization happens
server-side, through the deriver, via the runner's replace-window
primitive.

**Two-method contract:**

```
forward(window: Span):
  { rows: DerivedEvent[] }      // direct insertion (high-confidence
                                 //   or 'never' policy)
  | { prompts: PromptDraft[] }  // ask the user; complete() runs when
                                 //   each prompt is answered
  | { noop: true }              // nothing to do this cycle

complete(prompt: Prompt, answer: AnswerEvent):
  { rows: DerivedEvent[] }      // materialize the row(s) the prompt
                                 //   was about
```

**Plus declarations:**

```
prompt_kind:           string                // e.g. 'prompt.sleep_confirmation'
                                             //   one deriver claims one prompt_kind;
                                             //   runtime errors if two collide
confirmation_policy:   'always' | 'if_uncertain' | 'never'
threshold:             number                // for 'if_uncertain': insert directly
                                             //   when confidence >= threshold
```

**Behavior by policy:**

- `'always'`: `forward` always returns a prompt; `complete` materializes
  the row from the answer.
- `'if_uncertain'`: if `confidence >= threshold`, `forward` returns rows
  directly. Otherwise it returns a prompt, and `complete` materializes
  from the answer when it arrives.
- `'never'`: `forward` always returns rows. Degenerates to Deterministic
  if the propose step is pure. Use sparingly; if you're reaching for this,
  the deriver is probably actually Deterministic.

### LLM deriver lifecycle

Forward and complete are invoked separately by the runner; the deriver
owns both halves of the propose-confirm-materialize cycle.

**Forward pass (cron-fired).**

1. Runner triggers `forward(window)` per the deriver's cadence.
2. Deriver computes the heuristic, decides between rows / prompts / noop.
3. Runner writes the result through the same primitive in both branches:
   - `rows` → `agent_api.replace_derived_window(source, window_start, window_end, rows[])`
   - `prompts` → `agent_api.create_prompt(...)` (one call per draft)
   - `noop` → log only.

**Between forward and complete: state lives in `prompts.ctx`.**

When `forward` produces a prompt, it writes the context the deriver will
need at completion time into `prompts.ctx`:

```jsonb
{
  "window_start":         "2026-04-23T00:00:00Z",
  "window_end":           "2026-04-23T23:59:59Z",
  "heuristic_span":       { "start_ts": "...", "end_ts": "..." },
  "heuristic_confidence": 0.62,
  "input_event_ids":      ["..."]
}
```

No separate deriver-state table. Reconstruction at complete time happens
from `prompts.ctx` plus the answer event.

**Completion pass (poll-fired).**

The runner polls roughly every 60s for "answered, not yet derived"
prompts:

```sql
SELECT p.*, e.* AS answer_event
FROM public.prompts p
JOIN public.events  e ON e.id = p.answer_event_id
WHERE p.answered_at IS NOT NULL
  AND p.derived_at  IS NULL
  AND p.kind = :prompt_kind        -- the deriver's claimed kind
ORDER BY p.answered_at;
```

For each match, the runner calls `complete(prompt, answer_event)`. The
deriver returns `rows`; the runner writes them through replace-window
in a single transaction that also stamps `prompts.derived_at`:

```sql
BEGIN;
DELETE FROM public.derived_events
  WHERE source = :source AND start_ts >= :ws AND start_ts < :we;
INSERT INTO public.derived_events ...;
UPDATE public.prompts SET derived_at = NOW() WHERE id = :prompt_id;
COMMIT;
```

If anything in the transaction fails, the prompt stays unprocessed and
is retried on the next poll. Deriver code never has to reason about
partial-failure cleanup — the transaction is the unit of correctness.

**Completion latency.** Default polling interval is 60s. Sleep deriver
answers come hours after the question, so polling is plenty. If a
future deriver needs sub-minute completion, upgrade to a `pg_notify`
trigger on `prompts.answered_at` update, or have the prompt-answer
edge function HTTP-push the runner. Both are optimizations, not v1
requirements.

**No special handling for expired-unanswered prompts.** When
`expires_at < NOW() AND answered_at IS NULL`, the prompt is dead — no
row will ever be inserted for that window. The dashboard, if it cares
to render the heuristic, computes it on-read with an "(unconfirmed)"
or "(expired)" badge. Re-asking the same window is explicitly out of
scope; the don't-ask-twice guard would block it anyway.

### Idempotency guards

Two cheap checks make the full lifecycle rerun-safe.

**Don't ask twice.** Before `forward()` calls `agent_api.create_prompt`,
check:

```sql
SELECT 1 FROM public.prompts
WHERE kind = :prompt_kind
  AND (ctx->>'target_date')::date = :day
  AND (answered_at IS NOT NULL OR expires_at > NOW());
```

If a row exists (still pending, expired, or already answered), skip.
The `target_date` field is by convention; each deriver declares the
dimension it considers the "same window" for asking purposes.

**Don't derive twice.** The runner's poll filter (`derived_at IS NULL`)
plus the COMMIT-time stamp of `derived_at` make the completion side
idempotent. A crashed completion that didn't commit leaves
`derived_at = NULL`, so the next poll retries. A succeeded completion
has `derived_at` set, so it never reruns.

The audit trail in `derived_events.provenance.confirmation.prompt_id`
is the secondary record of which prompt produced which row;
`prompts.derived_at` is the operational pointer the runner reads.

### Schema impact

- `public.prompts` gains `derived_at TIMESTAMPTZ NULL`. Set in the
  same transaction as the derived-event insert; never set otherwise.
- Partial index for the poll:
  ```sql
  CREATE INDEX prompts_pending_derive ON public.prompts (answered_at)
    WHERE derived_at IS NULL;
  ```
  Keeps the poll cheap as the prompts table grows.

### What we don't need (yet)

**No supersedes column**. Corrections are delete-then-insert through
a re-confirmation flow (agent re-asks, user answers, new row lands).
If we ever find a case where we want row-level audit of every version
of a derivation, we'll add it. For personal-tool use, probably never.

**No speculative-insert-with-linker tier.** Discussed and rejected:
once you insert a guess, something downstream will consume it. Simpler
to never do it.

---

## 4. Derivations registry

Every derivation the system produces. Maps derivation kind → deriver
class → inputs → cadence → persistence.

**Input naming convention**: every input is either a primitive
referenced as `<device>.<source>` (matching exactly an entry in §2)
or another deriver kind referenced as `derived.<kind>`. Aliases like
"agent context" or "places" are not allowed — declare every input.

| kind                   | class          | inputs                                                                                 | cadence        | persistence | notes |
|------------------------|----------------|----------------------------------------------------------------------------------------|----------------|-------------|-------|
| `session`              | Deterministic  | `mac.system.window`, `mac.zen.tab`                                                     | on_read; stored if perf demands | mostly on_read | Cluster same-app focus spans with ≤N-min gaps. v1 computes per-query. |
| `mac_active`           | Deterministic  | `mac.system.afk`                                                                       | on_read        | on_read     | `union(events WHERE source='system.afk' AND data->>'status'='not-afk')` clipped to window. AW AFK is the canonical "actively-using-mac" signal; see decision log 2026-04-23. |
| `phone_active`         | Deterministic  | `phone.system.unlocked`                                                                | on_read        | on_read     | `union(unlocked spans)`. `system.unlocked` is the canonical "user actively using phone" signal — `system.foreground` over-counts when locked-screen rendering inflates app foreground tracking. |
| `idle_span`            | Deterministic  | `derived.mac_active`, `derived.phone_active`                                           | on_read        | on_read     | Gaps in `mac_active ∪ phone_active` lasting ≥ 2 min, clipped to `min(window_end, now)`. |
| `concurrent`           | Deterministic  | `derived.mac_active`, `derived.phone_active`                                           | on_read        | on_read     | `mac_active ∩ phone_active` |
| `top_apps_mac`         | Deterministic  | `mac.system.window` (per-app), `derived.mac_active` (mask)                             | on_read        | on_read     | Per-app duration totals, clipped to mac_active so passive-window time isn't credited. |
| `top_apps_phone`       | Deterministic  | `phone.system.foreground` (per-app), `derived.phone_active` (mask)                     | on_read        | on_read     | Per-app duration totals, clipped to phone_active. Pixel-launcher caveat: weight down or exclude. |
| `sleep`                | LLM, `if_uncertain` (threshold ≈ 0.85) | `mac.system.afk`, `phone.system.unlocked`, `phone.system.screen` | daily 16:00 (local CT) | stored      | Longest silence in night window ≥ 4h. Heuristic proposes; agent asks if ambiguous. |
| `place_visit`          | Deterministic  | `phone.location.reading`                                                               | every 15 min   | stored      | GPS clustering with bathroom-break tolerance. (`places` is a separate spec table — see `places.md` — referenced for label resolution, not as derivation input.) |
| `travel_leg`           | Deterministic  | `derived.place_visit`, `phone.activity.state`                                          | every 15 min   | stored      | Between consecutive visits. Blocked on `place_visit`. |
| `project_attribution`  | LLM, `if_uncertain` | `derived.session`                                                                | on_demand      | stored      | Classifier tags sessions with a project. Blocked on roadmap #8. |
| `media_playing` (planned) | Deterministic | (planned: `mac.media.playing` from `nowplaying-cli`)                                | on_event       | on_read     | Media as presence signal; requires new collector. |

### Idempotency for stored derivations

Deterministic derivers run on schedule and on demand; reruns must
not duplicate. **Replace-window semantics** are the canonical rule:

- A scheduled run for `(source, [window_start, window_end))` — where
  `source` is the deriver's `<kind>/<version>` identifier — first
  **deletes** any rows in `derived_events` matching:
  ```sql
  DELETE FROM public.derived_events
  WHERE source = :source            -- e.g. 'sleep/v1'
    AND start_ts >= :window_start
    AND start_ts <  :window_end;
  ```
- Then inserts the freshly computed rows.
- This makes reruns safe and lets us bump the version suffix
  (e.g. `sleep/v1` → `sleep/v2`) to recompute history without
  colliding with prior versions' rows.

For LLM derivers writing user-confirmed rows, no replace-window:
the prompts table prevents double-asking; once a confirmed row
exists, it stays unless the user explicitly edits.

### Per-kind `data` schema registry

`derived_events.data` is JSONB. Each `kind` declares its payload
shape here. Adding a new kind means adding to this table.

| kind                   | `data` shape                                                                                 |
|------------------------|----------------------------------------------------------------------------------------------|
| `session`              | `{device, dominant_app, apps: [{app, ms}], event_count}`                                     |
| `sleep`                | `{disrupted_count, source: 'heuristic' \| 'user_confirmed'}`                                 |
| `place_visit`          | `{place_id?: uuid, lat, lng, brief_exit_count}`                                              |
| `travel_leg`           | `{from_visit_id, to_visit_id, dominant_activity, distance_m, reading_count}`                 |
| `project_attribution`  | `{project_id: uuid, sessions: [uuid], confidence?: number}`                                  |
| `media_playing`        | `{app, title?, source}`                                                                       |

Drift is allowed within a kind — additive fields are fine, breaking
shapes require a deriver `version` bump.

### Timezone canon

- All timestamps stored UTC.
- "Day" boundaries for the dashboard and audit cadences are **local
  time at the device** (CT for Josh today). The orchestrator
  schedules cron jobs in CT explicitly.
- Travel across timezones: use the zone the user was in *at that
  moment*, not their current zone. Out-of-scope for v1; document the
  assumption rather than implement it.

### Adding a new derivation — ship checklist

1. **Decide class**: Deterministic (pure algorithm) or LLM (needs judgment).
2. **If LLM**: pick a `confirmation_policy` and (for `if_uncertain`)
   a confidence threshold.
3. **Declare** the new kind here:
   - Row in §4 (Derivations registry) with all inputs in canonical form
   - Row in "Per-kind `data` schema registry" above
   - Update §6 cross-references
4. **Implement** the deriver module:
   - Dashboard-side: `dashboard/server/derivers/<kind>.ts`
   - Orchestrator-side (LLM): job markdown under `/scrollantir/jobs/`
5. **Indexes**: confirm the views querying it have appropriate indexes
   on `(kind, start_ts)` for `derived_events`. The default partial
   index on non-superseded rows is in §1.
6. **Test fixtures**: add a synthetic input set + expected output to
   `dashboard/server/derivers/__fixtures__/` (or equivalent). Golden
   tests prevent silent algorithm drift across `version` bumps.
7. **Hook into scheduler**: orchestrator cron line for periodic
   derivers, or dashboard on-demand endpoint for `on_read` ones.
8. **Surface in dashboard**: add a corresponding entry in §5 (Views
   catalog) so the data has somewhere to be seen.

---

## 5. Views catalog

What the dashboard shows, declared explicitly so every UI number is
traceable to its data inputs.

| view                   | reads                                                                | description                                                   |
|------------------------|----------------------------------------------------------------------|---------------------------------------------------------------|
| `summary.mac_active`   | `derived.mac_active`                                                 | Hours actively using Mac today |
| `summary.phone_active` | `derived.phone_active`                                               | Hours on phone today |
| `summary.concurrent`   | `derived.concurrent`                                                 | Minutes using both at once |
| `summary.idle`         | `derived.idle_span`                                                  | Minutes idle ≥ 2 min threshold |
| `summary.top_apps_mac` | `derived.top_apps_mac`                                               | Ranked list with hours + % share |
| `summary.top_apps_phone` | `derived.top_apps_phone`                                           | Ranked list with hours + % share |
| `timeline.day`         | `mac.system.window`, `mac.zen.tab`, `phone.system.foreground`, `phone.system.unlocked` | 24h timeline with three lanes |
| `reports.list`         | `public.reports`                                                     | Agent-authored daily/weekly reports |
| `sleep.today`          | `derived.sleep`; on-read heuristic if no row + no pending prompt     | Confirmed sleep span for last night; renders unconfirmed heuristic with badge if absent |
| `sessions.today`       | `derived.session`                                                    | Session list for today |

### "ⓘ sources" affordance

Every view surface in the UI gets a small tooltip / side-panel
describing what it's reading. Powered directly from this catalog.
Self-documenting: add a view here, it shows up with its description.

### Adding a new view

1. Declare in the table above with its inputs.
2. Implement the read in `dashboard/server/views/`.
3. Render in the dashboard.
4. Automatically picks up the "sources" affordance if the view's
   registration includes the description.

---

## 6. Cross-references

Follow-the-arrow from primitive → derivation → view. Useful for "if
primitive X is broken, what breaks downstream?"

### Primitives → Derivations / views that read them

| primitive                      | feeds                                                                                |
|--------------------------------|--------------------------------------------------------------------------------------|
| `mac.system.window`            | `derived.session`, `derived.top_apps_mac`                                            |
| `mac.system.afk`               | `derived.mac_active`, `derived.idle_span`, `derived.sleep`                            |
| `mac.zen.tab`                  | `derived.session` (secondary), `derived.top_apps_mac` (tab-level detail)              |
| `phone.system.foreground`      | `derived.top_apps_phone`                                                             |
| `phone.system.unlocked`        | `derived.phone_active`, `derived.idle_span`, `derived.sleep`                          |
| `phone.system.unlock`          | (paired marker for `system.unlocked`; not consumed directly)                         |
| `phone.system.screen`          | `derived.sleep`                                                                       |
| `phone.location.reading`       | `derived.place_visit`                                                                 |
| `phone.activity.state`         | `derived.travel_leg`                                                                  |
| `prompt.sleep_confirmation`    | `derived.sleep` (user-confirmed branch)                                               |
| `prompt.project_attribution`   | `derived.project_attribution`                                                         |

### Derivations → Views that read them

| derivation              | surfaced in                                          |
|-------------------------|------------------------------------------------------|
| `derived.session`       | `sessions.today`, `timeline.day` (future)            |
| `derived.mac_active`    | `summary.mac_active`, `summary.concurrent`, `summary.top_apps_mac` (mask) |
| `derived.phone_active`  | `summary.phone_active`, `summary.concurrent`, `summary.top_apps_phone` (mask) |
| `derived.idle_span`     | `summary.idle`                                       |
| `derived.sleep`         | `sleep.today`, weekly-report (via orchestrator)      |
| `derived.place_visit`   | `timeline.day` (location lane, planned)              |
| `derived.travel_leg`    | `timeline.day` (location lane, planned)              |
| `derived.project_attribution` | project views (planned, roadmap #8)             |

---

## Decision log

Recording the architectural decisions that landed during design,
with dates and one-line rationale.

| date       | decision                                                                | rationale |
|------------|-------------------------------------------------------------------------|-----------|
| 2026-04-23 | Two tables: `public.events` (raw) + `public.derived_events` (derived)   | Different mutation contracts; clean RLS split |
| 2026-04-23 | DB stores only confirmed facts; heuristics computed on read only         | Eliminates "which version?" ambiguity |
| 2026-04-23 | No `supersedes` column; corrections via delete-then-insert               | Simpler schema, no multi-row version state |
| 2026-04-23 | Deriver hierarchy: Deterministic / LLM with `confirmation_policy`        | Formalizes which derivations need user input vs. not |
| 2026-04-23 | Reuse `public.prompts` as the "don't ask twice" marker                   | No new audit-log table needed |
| 2026-04-23 | `mac_active` and other aggregates are on-read only, not stored           | Keeps schema lean; trivial recompute |
| 2026-04-23 | Switch dashboard from focus-based idle to AW-AFK-based model             | Empirical test: focus-based labeled sleep as active; AFK-based catches it |
| 2026-04-23 | Phone "active" canonical signal is `phone.system.unlocked`, not `system.foreground` | `unlocked` is the attention signal; `foreground` is for per-app attribution. Resolves architecture.md vs. dashboard summarizer disagreement. |
| 2026-04-23 | `events.id` is UUID with deterministic generation per (collector, bucket, row) | Reconciles architecture.md (was `id TEXT`) with mac-forwarder UUID scheme; documented in §1 |
| 2026-04-23 | Stored derivations use replace-window semantics for reruns                | Random row IDs + scheduled rerun = duplication risk. Delete-by-(kind, version, window) before insert. |
| 2026-04-23 | Day boundaries are local time (CT); all timestamps stored UTC              | Single canon for cron schedules and dashboard day windows. |
| 2026-04-24 | Observer-stream principle: raw events are flat parallel streams; no `parent_event_id`. Cross-row relations live in derivers. | Weighed against nesting (e.g. cmux tabs under cmux windows). Nesting forces emit-time interpretation the collector can't always make (spotify on phone vs. mac). Flat keeps collectors brain-dead and pushes complexity to the replayable/versionable deriver layer. |
| 2026-04-24 | Fold device into `source` as `<device>.<namespace>.<specifier>`; expose `device` as STORED generated column from first segment | Single source-of-truth identifier; cross-references match column value; collectors can't emit mismatched (device, source) pairs. `cloud` device handles service-polled events without polluting `public.devices` with synthetic physical hosts. |
| 2026-04-24 | `(start_ts, end_ts)` canonical on both tables; `duration_s` is a STORED generated column | Range queries and GiST overlap indexing are deriver-critical; aggregation cleanliness preserved via the generated column. Wire format keeps `(start_ts, duration_s)` for collector simplicity; edge fn computes `end_ts` at insert. |
| 2026-04-24 | `derived_events.source` (`<kind>/<version>`) replaces the `kind` column + `provenance->>'deriver'` JSON path; replace-window keys on `source` directly | Symmetric with raw events' single identifier column; replace-window becomes a normal column predicate, not a JSON-path scan. |
| 2026-04-24 | Drop `created_by` from `derived_events` | Authorship is inferable: deriver registry maps source → runtime; user-confirmed rows carry `provenance.confirmation`. The column was redundant. |
| 2026-04-24 | Naming: `received_at` on raw, `created_at` on derived | Each name fits its purpose. Raw rows arrive from collectors over a transit (forensic value of the "received" framing — saved real debugging time on AW forwarder bugs). Derived rows are written in-place by the deriver — no transit, no "received" semantic. |
| 2026-04-24 | Source format CHECK regex on raw events; convention `cloud.<service>.<specifier>` for service-polled sources | Cheap insert-time safety net catching typos. No full sources-registry table needed for v1. |
| 2026-04-24 | `cloud` lives in `public.devices` with `kind = 'service'`; physical devices have `kind = 'physical'` | Lets the generated `device` column FK cleanly to `public.devices`; gives services a metadata home without conflating with physical hardware. |
| 2026-04-25 | LLM derivers own their full cycle: `forward()` (cron) + `complete()` (poll-fired on answered-but-not-yet-derived prompts). Every `derived_events` insert happens server-side, through the deriver. | Phone is just answer transport; nothing client-side ever touches `derived_events`. Each LLM deriver is the unit of accountability for its derivations end-to-end. |
| 2026-04-25 | `prompts.ctx` is the between-stages state store for LLM derivers; no separate deriver-state table | Reconstruct what the deriver needs at completion from `prompts.ctx` + answer event. Avoids a parallel state machine. |
| 2026-04-25 | `public.prompts` adds `derived_at TIMESTAMPTZ NULL`; set in the same transaction as the derived-event insert; partial index `(answered_at) WHERE derived_at IS NULL` for poll efficiency | "Don't derive twice" guard. Operational pointer the runner reads; provenance is the secondary audit record. |
| 2026-04-25 | Default ~60s polling for completion; pg_notify / HTTP push deferred as later optimization | Sleep is the only v1 LLM deriver and answers come hours late; polling is plenty. Avoid premature trigger plumbing. |
| 2026-04-25 | One `prompt_kind` per LLM deriver, enforced at runtime startup | Single dispatch path from answered-prompt → deriver. Two derivers claiming the same kind is misconfig the runtime should refuse. |
| 2026-04-25 | No special handling for expired-unanswered prompts; dashboard renders unconfirmed heuristic on-read with a badge | Honest behavior: deriver asked, user didn't answer, no row exists. Don't re-ask; the don't-ask-twice guard would block it anyway. |
| 2026-04-25 | `Deriver.source` is `<kind>/<version>` and is the single registry / row-source / replace-window key | Unified identifier across registry, written rows, and rerun rule. Bumping version is non-destructive (per-source replace-window scope). |

## Pointers

- `docs/architecture.md` — system diagram, collection patterns
- `docs/data-flow.md` — runtime placement, credentials
- `docs/session-2026-04-23-aw-forwarder.md` — the forwarder bug diagnosis that forced this model conversation
- `docs/dashboard.md` — UI surface the views catalog feeds
- `dashboard/server/` — implementation home for derivers + views (today holds summarize/blocks/idle; should grow into a deriver registry)
