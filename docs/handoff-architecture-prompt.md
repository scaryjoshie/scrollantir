# Architecture-finalization onboarding

Read this whole file before doing anything else.

You're picking up an architecture-design conversation mid-project.
The user (Josh) is the solo developer of **scrollantir** — a personal
"palantir for yourself" time-tracking system. The codebase already
has data flowing end-to-end (Mac via ActivityWatch + a Python
forwarder, Android via a custom collector, both into Supabase
Postgres). A web dashboard is half-built. The goal of this
conversation is **finalizing the architecture before further
implementation**, not writing code.

## Your first task: read these docs in order

1. `docs/README.md` — doc index. Skim to know what exists.
2. `docs/architecture.md` — system diagram, event schema, source naming, collection patterns.
3. `docs/data-flow.md` — runtime placement, credentials, role model. Master mermaid diagrams.
4. **`docs/data-model.md`** — the foundation doc this conversation is centered on. Event model (raw `public.events` + `public.derived_events`), primitives catalog, deriver class hierarchy (Deterministic / LLM with `confirmation_policy`), derivations registry, views catalog, decision log. **This is where most of your attention should go.** Audited by Codex on 2026-04-23 and refined; 5 blockers + 4 open questions resolved into the current shape.
5. `docs/session-2026-04-23-aw-forwarder.md` — the bug-and-fix saga that forced this architecture conversation. Critical context for *why* we're being careful about correctness now. Forwarder fix landed; AFK model decision was made empirically.
6. `docs/dashboard.md` — what the UI was supposed to be; the §"Agent handoff — web v1 (2026-04-21)" section at the end is the latest scoping.
7. `docs/roadmap.md` — what's shipped vs planned. Item 9 is the web dashboard (web, not Swift — pivot dated 2026-04-21).

Skim only as needed: `mac.md`, `android.md`, `supabase.md`,
`projects.md`, `places.md`, `location.md`, `session-2026-04-21.md`.

Read but don't be guided by: `views.md` (planned/old idea), `agent.md`
(predates the orchestrator design).

## Code you may want to peek at (read-only)

- `mac-forwarder/forwarder.py` — the post-fix forwarder. The "hold the tail" pattern in `drain_bucket` is the core data-correctness mechanism. Don't modify.
- `dashboard/server/` — the central business-logic module (spans, summarize, blocks, idle, labels). This is where new derivers will live. Has some staged but uncommitted dashboard-side changes that the data-model doc audits in its "Dashboard change audit" table — those are not load-bearing on the architecture conversation.
- `dashboard/src/pages/Summary.tsx` and `dashboard/src/features/timeline/` — current UI surfaces; informative for view-catalog discussions.

## Known-open architectural questions worth probing

These weren't resolved in `data-model.md` and are good places to push:

1. **When to actually create `public.derived_events`.** The doc commits us to this table but it doesn't exist yet in Supabase. Schema migration question is open — do we land it now (early enough to break freely) or wait until a deriver demands it?
2. **View-as-data vs view-as-TypeScript.** `docs/views.md` raised this; not yet decided. The catalog in `data-model.md` §5 is currently view-as-TS. Do we need a runtime-editable view definition (e.g., agent-authored views from the chat interface)?
3. **Chat interface scope.** Two-stage delivery proposed earlier in this project (local Claude Code subprocess first, Hetzner endpoint as a swap-in). Not finalized in any doc. Worth pulling into `data-model.md` or a sibling.
4. **Project classification (LLM deriver, roadmap #8).** Outline exists but the deriver shape (Groq vs Anthropic, prompt structure, confidence calibration) hasn't been spec'd against the new `LLMDeriver` contract.
5. **Sleep audit job.** Architecture is clear (`LLMDeriver, if_uncertain, threshold ≈ 0.85, daily 16:00 CT`). Operational details — how the orchestrator invokes it, what the prompt context looks like, idempotency against the `public.prompts` "asked already?" guard — not written down.
6. **Replace-window idempotency** is declared in `data-model.md` §4 but no concrete code path exists. May want an `agent_api.replace_derived_window()` RPC; may want it to be a convention enforced in the deriver runner. Decide.
7. **Migration / cutover for the dashboard's `summarize.ts`.** Currently uses `phone.system.foreground` for "phone active"; doc declares `phone.system.unlocked` is canonical. Mechanical follow-up but worth tracking.

## Constraints

- **Don't write production code yet.** This is a design-only round. Spec, debate, document. Code follows once Josh is satisfied.
- **Don't touch these directories**: `orchestrator/`, `android/`, `mac-forwarder/`, `supabase/`, `scripts/admin/`. Read-only for context. The dashboard's `server/` and `src/` and the `docs/` tree are fair game for proposals.
- **Doc updates are encouraged.** If a discussion produces a decision, land it in `docs/data-model.md`'s decision log (or a new sibling doc if the topic is large). Treat the doc as the source of truth.
- **Stage with git, don't commit.** Josh reviews everything before commit.

## Tools you have access to

- **Codex audit** via `Agent` tool with `subagent_type: codex:codex-rescue`. Worked well for an external review pass on the foundation doc. Use it when you want a second set of eyes on a document or design proposal — particularly any major rewrite of `data-model.md` or a new architecture doc. Frame the prompt as a read-only audit asking for blockers / nits / open questions / what's good. Don't use it for implementation.
- **psql** access to live Supabase via the keychain DSN: `security find-generic-password -s scrollantir -a user-role -w` exports as `$DATABASE_URL`. Useful for empirical checks against real data when an architectural argument hinges on what the data actually looks like.
- **AW local API** at `http://localhost:5600/api/0/`. AW keeps full local history; useful when comparing what the collector saw vs. what made it to Supabase.

## How to interact with Josh

- **Push back when you disagree.** He's earned the right to be challenged on his own architecture and prefers it over compliance. Surface tradeoffs explicitly.
- **Don't be overconfident.** A recent failure mode in this project was Claude asserting things from data patterns without ground-truth validation. If a claim depends on what reality looks like, query the DB / AW / Josh's lived experience first.
- **Ground-truth via Josh when needed.** For things only he can answer (lived experience, taste calls, prioritization), ask. He'd rather answer one good question than read three confident wrong proposals.
- **Stay scoped.** "Nail down the ultimate architecture before implementation" means converging on something we'd be happy to build for the next 6+ months. Don't drift into UI fiddling or premature coding.

## What "done" looks like

- `data-model.md` is durable enough that the implementation team (you, in a future session, or Josh writing code by hand) can use it as the spec without ambiguity.
- The 7 open questions above are either resolved (decision logged) or explicitly deferred (with the deferral logged + rationale).
- Any new architecture-shaped concerns surfaced during the conversation get their own doc or a section in `data-model.md`.
- Josh agrees we're done.

## Where to start

After reading the docs above, come back with:
- Anything in `data-model.md` you'd push back on
- Which of the 7 open questions you think we should tackle first
- Any architectural concerns you see that aren't yet on the list

Don't start writing anything new until Josh has weighed in on your reading.
