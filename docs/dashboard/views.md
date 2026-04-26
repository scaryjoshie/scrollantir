# Views — CLI-authored dashboard pages

## The idea

Views are just React pages in the dashboard repo. You ask a CLI coding agent to make one, it writes a file, Next.js picks it up.

```bash
$ claude "make me a view that shows class attendance this week"
# → writes dashboard/app/views/class-attendance/page.tsx
# → visible at http://localhost:3000/views/class-attendance on save
```

No runtime template library, no views-as-rows-in-a-table, no "preview" pipeline. The infrastructure is **Claude Code + file system + Next.js**. What we need is good conventions so the CLI produces consistent, working pages every time.

## Status

🚧 Scaffolding work. Depends on the dashboard existing (see `dashboard.md`, TBD).

## What needs to exist

1. **Directory convention:** `dashboard/app/views/<slug>/page.tsx`. One view per directory. Server components by default; client components when interactivity is needed.
2. **A scaffold template:** `dashboard/app/views/_scaffold/page.tsx.example`. Blank page with:
   - Supabase server-side client set up
   - Date-range param wired (`?start=...&end=...`)
   - User-auth session read
   - Tremor `Card` + `Title` wrapping the content
   - Commented placeholder: `// TODO: replace with your query + rendering`
   The CLI copies this and modifies.
3. **`AGENTS.md` at the dashboard repo root** with the conventions the CLI must follow:
   - "Before writing a view, read `docs/supabase.md` and `docs/places.md`"
   - "Queries go through the authenticated Supabase client; never bypass RLS"
   - "Use Tremor for charts (`<AreaChart>`, `<BarList>`, `<LineChart>`), shadcn/ui for layout"
   - "All views accept `?start=` and `?end=` params for date range"
   - "Put heavy computation in SQL, not in JS"
   - "Each view exports `metadata = { title, description, category }` for the nav"
4. **Two or three hand-written reference views** so the CLI has style to mimic:
   - `app-time-today/page.tsx` — simplest read, just a ranked list
   - `class-attendance/page.tsx` — more complex, joins `places` + `place_visits` with schedule-awareness
   - `short-form-ratio/page.tsx` — time-series, good LineChart example

## What the CLI does in practice

Typical session:

> **You:** `claude "build a view that shows focus blocks — stretches where no social-media app was foreground for >30 min"`

> **Claude Code:**
> 1. Reads `AGENTS.md`, `docs/supabase.md`, `docs/views.md`
> 2. Checks existing views in `dashboard/app/views/` for style
> 3. Copies `_scaffold/page.tsx.example` to `app/views/focus-blocks/page.tsx`
> 4. Writes SQL against `events` + `source_tags` to identify gaps where `social_feed` / `short_form` tags weren't active for ≥30 min
> 5. Renders with Tremor `<TimelineBand>` or similar
> 6. Adds a nav entry
> 7. Runs dev server (if not running) and reports the URL

## Authoring guardrails

The CLI should:

- **Read the schema doc before every session.** New CLI sessions don't remember prior context. `AGENTS.md` must explicitly instruct "read these files first."
- **Name views clearly.** Slugs become URLs: `/views/class-attendance` not `/views/view-2026-04-20-abc`.
- **Not duplicate existing views.** Before creating, `grep dashboard/app/views/` for similar pages, reuse or extend instead.
- **Prefer composition.** If a view needs a bar chart of top-10 apps by time, and there's already a reusable `<TopAppsBar />` component, use it. Factor out common pieces as shared components over time.

## The "update an existing view" path

Equally important. You've got a view that shows last 7 days and you want last 30 instead.

> **You:** `claude "change class-attendance to show the last 30 days by default"`

CLI edits one file. Git diff is the audit trail.

Views are source-controlled like any code. Breaking changes surface as build errors, not silent data corruption.

## What this is NOT

- **Not a runtime dashboard CMS.** No views table. No template picker. If you want a new view, the CLI writes one.
- **Not a limited template zoo.** Anything React can render, a view can render. The "templates" are de facto Tremor/shadcn patterns that emerge naturally in the code.
- **Not agent-authored at runtime.** Views are generated during CLI sessions, committed to git, deployed via normal pipeline. Static at runtime.

## Conventions for quality

- **Server components by default.** Queries happen server-side; the client receives rendered data. Keeps Supabase credentials out of the browser and reduces bundle size.
- **Date-range as URL params.** Enables sharing a link that shows "class attendance for last semester."
- **Empty-state handling.** When a query returns no rows, show a helpful message ("No classes tracked yet — add some in Settings"), not a blank chart.
- **Loading states.** Next.js `loading.tsx` conventions.
- **Reuse a shared Tremor theme** so visual consistency doesn't depend on the CLI getting colors right every time.

## When does this break down

Two scenarios push beyond CLI-authored-static-pages:

1. **You want the dashboard to react to data it doesn't have yet** (e.g., "build me a view for every class I take this semester," which implies dynamic routing based on the `places` table). Handle with a single parameterized view, not N static views.
2. **You want non-technical people to build views**. Not your use case. Shelf indefinitely.

If either becomes real, revisit a runtime system. Until then, the CLI + file system + Next.js is the system.

## Starter views to hand-write

Reference set worth shipping as examples:

| Slug | Question | Template cue |
|---|---|---|
| `today` | Emoji timeline of today | Horizontal bands with place-activity labels |
| `app-time-today` | Top apps foregrounded today | Ranked list with icon + duration + bar |
| `class-attendance` | Did I go to class this week? | Day × class grid, color-coded attended / late / skipped |
| `short-form-ratio` | % of social time spent in Shorts/Reels, 30d | Line chart |
| `phone-vs-mac` | Device-mix over today | Stacked area |
| `unnamed-places` | Stationary clusters not yet named | Ranked list with "name this" affordance |

These cover the templates the CLI will most need to mimic.
