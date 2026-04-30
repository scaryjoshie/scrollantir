# Scrollantir Tenets

Durable principles that should constrain implementation decisions. When a tenet conflicts with a tactical fix, the tenet wins until explicitly revisited here.

These were extracted from collaboration sessions; they reflect the user's repeated guidance, not generic best-practices.

---

## 1. Never discard or hide raw data

If a chunk, event, or row arrives malformed, the response is **investigate, not delete**. The pipeline's job is to faithfully record what happened. Future analysis should be possible against the full history.

Concretely:
- Don't `DELETE FROM events WHERE …` to clean up "junk." Junk is signal — figure out why it's junk.
- Don't filter out events at the deriver stage to hide a problem. Either fix the source or document the limitation.
- Worst-case allowed: **obscure** (dim, render as "unknown", group into "Other"). Never erase.
- One-way data deletions need explicit user OK.

The 2026-04-30 "delete unnamed OSM places" recommendation was a violation of this tenet. The right move was to investigate (turned out: real Northwestern buildings without public OSM names) and improve rendering, not delete.

## 2. Investigate before patching

Symptom in the dashboard = data question. Query the production DB; understand the actual distribution; THEN decide whether the patch is grounded or speculative.

The chain "I see a bug → I add a fallback → I move on" produces accumulating defensive code that nobody can later remove without exhuming the original case. Replace with: "I see a bug → I query for distribution → I understand the cause → I fix the cause OR document why a fallback is the right answer."

The 2026-04-30 "78% of chunks under 30s, that's noise" was a violation. User's actual pattern is heavy alt-tabbing; the data was truthful. Phase G was retired after recognizing this.

## 3. Prefer general systems over hardcoded edge cases

If the code special-cases the strings `'personal'` and `'misc'`, the data model is wrong. Fix the model so the special case becomes structural. Defensive `if foo === 'X'` chains are a tax on every future reader.

The tree-model invariant (`project_slug != null IFF category = 'work'`) is the structural fix; the DB CHECK constraint is the truth, validators + view coercions are belt-and-suspenders during rollout.

## 4. Magic numbers must cite their data

Threshold constants (`night_floor_min`, `gap_within_span_min`, `same_place_max_gap_hours`, etc.) need a comment naming the real-data observation that tuned them. "Set to 12 because of the user's 11.5h Willard split on 4/29" is a real comment. "Set to 12 because 7 felt too short" is not.

If a threshold isn't tied to observed data, it's a guess; either query the data or remove the threshold.

## 5. Atomic commits, documented rollbacks

Every shipped change is one logical unit, one commit. Migrations have explicit `migrate:down` blocks. Production-touching changes get a pre-written rollback recipe before applying — see `docs/TODO.md` rollback table.

If a change can't be cleanly undone, that's a design decision worth flagging — say it explicitly rather than silently shipping irreversibility.

## 6. Don't refactor without explicit confirmation

Big structural changes (table rename, deriver framework rework, schema migration with data loss) need a plan in conversation first. Code lives durably on branches; the user OKs architectural changes before they merge.

Bug fixes, additive features, and clearly-scoped refactors can ship within an established trajectory. "Re-thinking the data model" can't.

## 7. Don't over-engineer for hypothetical scale

Scrollantir is a single-user self-hosted app. 14 places, ~300 chunks/day, sub-megabyte database. Don't write code that assumes 10K places and a million chunks unless that's the explicit task. When the actual scale doesn't match the assumed scale, the code becomes harder to read for no benefit.

The flip side of this tenet: when scale assumptions break, address them. Don't ignore a real bottleneck because "it works for one user."

## 8. Audit before merging substantial work

Multi-commit branches that touch the data model or production runtime get an audit pass before merging to main. Either spawn a review agent or cite the user's review.

Phase B / C / E touch enough surface area that they qualify. A single bug fix doesn't.

## 9. Keep the framework simple

The data model is good when it's simple: events flow in, derivers compute spans, the dashboard renders spans. Resist adding tiers or abstractions until a concrete need forces them.

If a new feature seems to need 4 new tables, ask first whether it could fit existing structures. Most do.

## 10. Simulate the user's view before shipping data

Before any data lands in the dashboard, mentally render it as the user would see it. Ask: "would this be useful? Would I know what's going on?"

`com.instagram.reels` is technically correct but unpolished — the user has to do work to translate it to "Instagram Reels." `building:7088849` is technically correct but unpolished — the user sees a meaningless OSM ID. `scrollantir` is technically correct but unpolished — the user named their project "Scrollantir."

Concretely:
- Display names, not slugs / IDs / package names. (`projects.name`, not `projects.slug`. App display names, not bundle IDs. Place names, not `building:NNN`.)
- User-facing time labels read naturally ("2h 15m", "8:26 AM"), not technical (1700-formats, ISO timestamps).
- Tooltips and chips are written as English, not codes ("Walking" not "walking", "Foster-Walker Complex" not "foster-walker").
- Empty states say something true but useful ("No activity recorded for this visit" beats "0 chunks").
- Numbers have units. Distances need "m" or "km", durations need "min" or "h", percentages need "%".

If a piece of data renders as a code/slug/ID anywhere a user can see it, that's a polish bug — file it. The user should never need to know the difference between `slug` and `name`.

## 11. Surface the metrics we emit

Per-tick metrics (`osm_errors`, `null_place_visits`, `activity_unknown_legs`, `spans_skipped_pre_window`, etc.) are emitted to nowhere. If we don't read them, fallbacks paired with them silently grow. Either pipe them to a place a human looks (agent stdout, a small dashboard panel, a daily summary log) or drop both the metric and the fallback.

---

## Anti-patterns to avoid

- "I'll just add a `try / catch` here in case." → Why? Has it ever fired? If not, let it fail loudly.
- "Defaulting unknown values to 'X' for safety." → Silent corruption. Raise instead, or count and re-classify.
- "We can clean this up later." → Later doesn't come. Either clean now or write the cleanup as an explicit TODO with the cause documented.
- "Just delete the rows that look weird." → See Tenet 1.
