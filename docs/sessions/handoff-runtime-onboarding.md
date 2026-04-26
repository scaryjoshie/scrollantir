# Runtime rebuild — agent onboarding

You are picking up scrollantir, a personal time-tracking system Josh
is building. You are joining mid-project, after a major design +
cleanup session on 2026-04-25 that prepared the repo for the next
phase. Your job is to scaffold a new `runtime/` folder that will
replace the existing `orchestrator/` POC. Read the docs below in
order before touching any code. **Do not start writing the runtime
yet — first confirm the open questions at the end of this doc
with Josh.**

### What scrollantir is (one paragraph)

A personal "palantir for yourself" time-tracker. Structured event
streams from Android (`android/`) and Mac (`mac-forwarder/`) flow
into Supabase Postgres via three edge functions. A reasoning agent
(Claude Code CLI in a Docker container on Hetzner) reads via
`agent_role`, writes reports + prompts via `agent_api.*` RPCs.
Single-user, self-hosted, Postgres as system of record. Dashboard is
a web app at `dashboard/` (in progress). The data model is two
tables: `public.events` (raw, immutable, append-only) and
`public.derived_events` (computed, replace-window-keyed). Specs are
under `docs/`.

### What "runtime/" is (one paragraph)

A new top-level folder you will scaffold to replace the existing
`orchestrator/`. The new shape is a docker-compose stack on Hetzner:
a Python agent process (one custom Dockerfile), Caddy for HTTPS
(official image, mounted Caddyfile), and a reserved Postgres slot
for if/when Supabase becomes constraining (not v1). The Python
agent supervises cron-fired `forward()` passes for derivers and
runs a ~60s poll for `complete()` dispatch on answered prompts.
The existing bash-and-Claude-CLI orchestrator continues running in
parallel during the rebuild and is retired only after `runtime/`
reaches parity.

### Reading list (this exact order)

The reading is layered: project context → contract → forward spec.
Aim for ~45 min total.

1. `docs/README.md` — index of every doc, organized by area. Skim
   to know what exists.
2. `docs/architecture.md` — system diagram, event schema, source
   naming, collection patterns (Pattern B).
3. `docs/data-flow.md` — runtime placement, credentials per arrow,
   trust boundaries, role model. Master mermaid diagrams.
4. **`docs/data-model.md`** — the contract every component reads
   from. Two-table model, deriver class hierarchy (Deterministic /
   LLM with `confirmation_policy`), derivations registry, replace-
   window semantics, decision log. **Most of your attention should
   go here.**
5. `docs/concepts/places.md` — named-location layer + visit
   consolidation. The first deriver you'll ship (`place_visit/v1`)
   computes against this.
6. `docs/concepts/location.md` — collection spec for raw GPS +
   activity events. Already shipped on Android.
7. `docs/runtime/README.md` — the POC orchestrator that's currently
   live. You're replacing this.
8. **`docs/runtime/rebuild-plan.md`** — your spec. End-state, derivers
   to ship, hard prereqs, 11-step migration sequence. **This is the
   doc you'll be working from.**
9. `docs/sessions/session-2026-04-25.md` — chronicle of the 10
   design decisions that shaped the rebuild plan. Read for the
   *reasoning* — the spec doc has the *result*.
10. `docs/sessions/session-2026-04-23-aw-forwarder.md` — context for
    the AFK-vs-derived-idle reversal (read postscript at top).
11. `docs/runtime/agent.md` — `agent_role` + `agent_api.*` RPC
    reference. The new agent uses these unchanged.

### Things to know that are NOT in canonical docs

- **The current `orchestrator/` is committed at last** (commit
  `8280ea1`). Phase 0–2 are live on Hetzner CAX11 + systemd. Don't
  touch this folder until `runtime/` reaches parity.
- **Workout deriver design** is in
  `docs/sessions/session-2026-04-25.md` §5 but not yet in the
  data-model.md derivations registry. Add it as part of your work
  if/when you implement `workout/v1`.
- **Phone-activity-gated** is a SQL view (not a deriver). See same
  chronicle §6.
- **STILL-overlap rule for `place_visit/v1`** is in the chronicle
  §3 but not yet in `concepts/places.md` body. Add it when you
  implement.
- **The roadmap.md was last refreshed 2026-04-21** — assume it's
  partly stale for items past #5. The session chronicles are the
  source of truth for what's happened since.

### Don't touch

These are live-production or out-of-scope:

- **`orchestrator/`** — running on Hetzner, writing reports daily.
  Read for reference; don't modify until `runtime/` is replacing it.
- **`mac-forwarder/`** — running on Josh's Mac via launchd, posting
  events every 30s.
- **`android/`** — the phone app. Source of `phone.location.reading`,
  `phone.activity.state`, etc. Sources you'll consume; don't modify.
- **`supabase/migrations/`** — schema is mostly stable; you'll
  need to *add* migrations (for `derived_events`, `places`,
  `prompts.derived_at`), not modify existing ones.
- **`dashboard/`** — web app in progress. Stays as a separate
  top-level folder; will be revisited after `runtime/` settles.
- **`scripts/admin.py`** — local admin CLI; out of scope.
- **`.claude/settings.local.json`** — gitignored per-user override.

### How to behave

- **Ask Josh before scaffolding.** The "decisions to confirm" section
  in `runtime/rebuild-plan.md` lists six items. Confirm them as a
  batch before the first `mkdir runtime/`.
- **Commit in coherent blocks.** This repo accumulates work and
  commits in logical groups (~5–8 files, one concern). Don't make
  one giant commit; don't atomize either. Match the style of
  `git log --oneline -10`.
- **Tag commits with a `Co-Authored-By:` trailer.** The repo
  convention is the existing pattern in `git log` — match whatever
  identifier reflects you.
- **Never `--no-verify`.** If a hook fails, fix the underlying issue.
- **Don't run destructive ops (force-push, hard reset, mass deletes,
  schema drops) without explicit confirmation** even if your harness
  technically permits it.
- **Never echo `AGENT_DATABASE_URL`, `service_role` DSN, or device
  bearer tokens** into log files, reports, or commit messages. Read
  them only from the macOS Keychain entries listed in `data-flow.md`.
- **Doc updates are encouraged.** When a discussion produces a
  decision, land it in the canonical doc (`data-model.md` decision
  log, `concepts/places.md` for visit rules, etc.) — don't only
  mention it in chat.

### Verification checks before you start

Run these to confirm the repo state is what this prompt assumes:

```bash
# Working tree clean (no in-flight work to step on)
git status

# Latest commit is the rebuild-plan + chronicle
git log --oneline -3
# expect: 8c7bb0e docs: runtime rebuild plan + session-2026-04-25 chronicle (or newer)

# runtime/ doesn't exist yet
test -d runtime && echo "runtime/ already exists — read it before scaffolding" || echo "runtime/ absent — ready to scaffold"

# orchestrator/ is the POC (still alive)
test -f orchestrator/Dockerfile && echo "POC orchestrator present"

# Data model migrations status
ls supabase/migrations/
# expect: 5 files dated 2026-04-20 / 2026-04-21
# you'll be adding new migrations for derived_events + places + prompts.derived_at

# Confirm forwarders alive (only Josh can run these)
launchctl list | grep scrollantir         # mac forwarder
ssh $SCROLLANTIR_VM 'sudo systemctl status scrollantir-orchestrator --no-pager | head -8'  # orchestrator
```

### Open questions to confirm with Josh before scaffolding

These are listed in `rebuild-plan.md` §"Decisions to confirm with Josh"
and `session-2026-04-25.md` §"Open questions." Verify each as a yes/no
with Josh before any `mkdir`:

1. Folder name `runtime/` (not `host/`, not `agent/`)?
2. Python for the agent (not extending bash)?
3. Caddy in the compose stack from day one?
4. `postgres/` reserved slot but not populated in v1 (Supabase remains
   data plane)?
5. Deterministic derivers as Python modules (not raw SQL files)?
6. Where does the deriver runner *run*? Same host as `runtime/`
   (Hetzner) is the assumed answer.
7. Reuse `orchestrator/runtime/{CLAUDE.md, jobs/, skills/}` verbatim
   into `runtime/agent/prompts/`?

Plus three secondary checks:
- Does Supabase have `earthdistance` available? (Verify before writing
  `place_visit` SQL.)
- Is the existing `roadmap.md` worth a refresh as part of starting
  this work, or do we leave that for later?
- Should `workout/v1` ship in the first runtime/ wave, or after the
  derived_events table is exercised by `place_visit` + `travel_leg`?

### When you've finished onboarding

Reply to Josh with:

1. A **2–3 sentence summary** of what scrollantir is and what
   `runtime/` will do. (Validates you understood the architecture.)
2. **Your read on the open questions above** — for each, what would
   you propose as the answer, with one-line reasoning?
3. **Any contradictions or confusions** you noticed across the
   reading list. Doc drift may exist; surface it instead of
   silently picking one interpretation.
4. **A proposed first commit** — likely the empty `runtime/agent/`
   skeleton with a `scheduler.py` that just logs "tick" every minute,
   per the rebuild plan §"Migration sequence" step 1.

Don't run `git commit` until Josh greenlights both the open questions
and your proposed first commit.
