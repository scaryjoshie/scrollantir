# Views — agent-authored custom dashboards

## Motivation

Scrollantir's raw data answers arbitrary questions, but you don't want to write SQL against Postgres every time you wonder "did I skip class this week?" or "how much of my YouTube time was Shorts?". The agent already has context (schedule, places, app usage patterns) — let it generate **views**: named, reusable chunks of dashboard UI that wrap a specific analytical question.

## What a view is

A named combination of:

- **A data spec** — one or more SQL queries against the Supabase tables, parameterized on things like date range and user.
- **A rendering spec** — how to turn the query result into something you can look at: number tile, bar chart, line chart, ranked list, heatmap, timeline band, emoji summary, etc.
- **Metadata** — title, description, category, refresh cadence, who asked for it, when.

Example views the agent might author:

- **Class Attendance** — rows per class × week, color-coded attended / late / skipped. (Query: `places` with `schedule` × matched visits × expected day/time matrix.)
- **Short-Form Ratio** — fraction of YouTube / Instagram time spent in Shorts/Reels, per day for last 30 days. Line chart.
- **Focus Blocks** — stretches where no social-media app was foreground for >30 min, rendered as bands over a daily timeline. Plus a rolling 7-day total.
- **Unexpected Places** — time spent at GPS clusters that aren't yet in `places`. Ranked list with "name this place?" affordance.
- **Mac/Phone Overlap** — stacked area of `active_mac ∩ active_phone` vs `mac_only` vs `phone_only` over a day.

## Status

🚧 Planned. Depends on:

1. Mac + phone data both flowing to the Supabase backend
2. A baseline dashboard UI shell (native Swift or Next.js — see [dashboard](#) doc, to be written)
3. Agent plumbing with `agent_api` RPCs (see `supabase.md`)

## Two architectural options

Both have honest tradeoffs. The decision is worth thinking through before building.

### Option A — Views as data (safer, less flexible)

Views live as rows in a `views` table. Dashboard is a fixed shell that reads view rows and renders them using a small library of predefined rendering templates.

```sql
CREATE TABLE views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,                     -- "attendance", "focus", "media", ...
  template TEXT NOT NULL,            -- "ranked_list" | "line_chart" | "stacked_area" | "timeline_band" | "kpi_tile" | "heatmap" | "text_summary"
  query_sql TEXT NOT NULL,           -- parameterized SQL, expects named params :start, :end, :user
  render_config JSONB,               -- template-specific: which columns map to x/y/color, formatters, etc.
  refresh_cadence_s INT DEFAULT 300, -- how often the dashboard re-runs the query
  pinned BOOLEAN DEFAULT FALSE,      -- show on home dashboard
  created_by TEXT,                   -- "agent" | "user"
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Pros:**
- Sandboxed: agent can only author queries + pick a template; can't ship arbitrary code.
- Simple security: SQL runs via existing `agent_api` role with constrained permissions. RLS handles multi-user.
- Dashboard has a finite, auditable rendering surface.
- Easy to list / rename / delete views.

**Cons:**
- Limited to predefined templates. Novel visualizations require new template code.
- Query-only — can't do multi-step computation (could via SQL, but ugly).

**Who picks templates:** the agent, when authoring. Agent has access to a list of available templates and their required columns.

### Option B — Views as TypeScript files (flexible, more surface area)

Each view is an auto-generated `.tsx` file in the dashboard repo. Agent writes files, commits via MCP tool or deploys via Vercel's API.

```
dashboard/app/views/
├── class-attendance.tsx
├── short-form-ratio.tsx
├── focus-blocks.tsx
└── ...
```

Each file exports:

```tsx
export const meta = {
  name: "Class Attendance",
  category: "attendance",
  query: sql`SELECT ... FROM places JOIN ...`,
};

export default function View({ data }: { data: Row[] }) {
  return <Whatever />;  // any React component
}
```

A discovery mechanism (file glob, imports, or a registry) populates the dashboard nav.

**Pros:**
- Unbounded: view can be anything React + Tremor/shadcn/recharts can render.
- Composable: one view can embed another.
- Full code review trail — each view is a PR.

**Cons:**
- Agent has to write and deploy code. Security-sensitive.
- Requires a build/hot-reload pipeline that can pick up new files.
- Harder to list views programmatically; needs a registry.

### Recommended: start with A, escape to B as needed

**Ship Option A first.** Ten or so templates cover 90% of what we'd want for a personal dashboard. Agent authoring becomes a structured tool call — `create_view(name, template, query_sql, render_config)` — which is far easier to sandbox, audit, and iterate on than "agent writes TypeScript."

If a user (Josh) requests something that doesn't fit any template, add a template. If the template zoo keeps growing without plateau, that's the signal to move to Option B.

## Template library (starter set for Option A)

| Template | Data shape | Looks like |
|---|---|---|
| `kpi_tile` | 1 row, numeric value + optional delta | Big number with label and trend arrow |
| `ranked_list` | N rows, label + value (+ icon?) | Top-10 list, bar filled proportionally |
| `line_chart` | time-series (x, y) | Line over time |
| `stacked_area` | time-series (x, y, category) | Stacked area over time |
| `bar_chart` | categorical (x, y) | Vertical bars |
| `heatmap` | 2D grid (x, y, value) | Color-coded grid |
| `timeline_band` | (start, end, color, label) rows | Horizontal bands along a time axis |
| `text_summary` | single string (rendered Markdown) | LLM-generated natural-language summary |
| `emoji_timeline` | rows (start, end, emoji, label) | The daily narrative from places+activity |

`text_summary` is the escape hatch — the query can return a single LLM-generated sentence. "You attended 4 of 5 classes this week, skipped CHEM 101 on Wednesday."

## Agent tool surface

When the agent is composing a view, it needs these tools:

```typescript
list_templates(): TemplateSpec[]
  // Returns template name, required columns, optional render_config fields

list_tables(): TableSchema[]
  // Returns schemas of events, places, source_tags, etc.

describe_query(sql: string): { columns: Column[], estimatedRows: number }
  // EXPLAIN-style feedback before committing

create_view(name, template, query_sql, render_config, pinned): ViewId
delete_view(view_id): void
update_view(view_id, fields): void
list_views(): View[]
preview_view(view_id, date_range): RenderedResult
  // Runs the query, returns the rendered data shape for inspection
```

Agent's typical workflow:

1. User asks: "Can you build me a view that shows how often I've been skipping class?"
2. Agent: `list_tables()` → knows about `places`, `place_visits`, scheduled-expectation view
3. Agent: `list_templates()` → picks `heatmap` (day × class grid)
4. Agent: drafts SQL, runs `describe_query` to sanity-check columns
5. Agent: `create_view(...)` → commits
6. Dashboard refreshes, view appears

## Parameterization

Views take a few standard params:

- `:user_id` — injected by the dashboard based on auth
- `:start` / `:end` — date range (today, this week, last 30 days, etc., toggleable per view)
- `:timezone` — for "today" queries

Agent composes queries using these placeholders. RLS on the tables means an escaped `:user_id` can't cross users.

## Refresh cadence

Each view sets its own `refresh_cadence_s`:

- KPI tiles: 60s
- Line charts over hours/days: 300s
- Heatmaps over weeks: 3600s
- Text summaries (cost money per call): 21600s (6hr) or manual

Dashboard polls. A running view with a slow cadence shows "last updated Xmin ago" so you know you're looking at cached data.

## Privacy / auth

Views execute via `agent_api` role with constrained privileges: `SELECT` on `events`, `places`, `source_tags`, `content_items`; no other writes. RLS scopes all reads to the requesting user. Agent can't accidentally expose another user's data because there isn't one, but the scaffolding is right for future-you.

## Open questions

- Does the agent author views *in addition to* pinning existing ones, or only the latter? Answer: both — agent should be able to say "I built you a new attendance view" AND "I pinned the existing short-form ratio view to your dashboard."
- Do views have permissions (sharable)? Personal system, no. Add later if needed.
- Do we allow arbitrary text-summary LLM calls from views? Yes, via a dedicated RPC that caches results per (view_id, date_range) to avoid runaway costs.
- Do we want view composition ("dashboard" = grid of pinned views)? Yes, likely. A `dashboard_layouts` table comes after the view model is stable.

## First views to build (when we ship)

To have a real shakedown of the view system:

1. **Class Attendance** — ranked list or heatmap of scheduled-vs-attended
2. **Phone-vs-Mac Today** — stacked area showing `both`, `mac_only`, `phone_only` over the day
3. **Short-form Ratio** — line chart, % of YouTube+IG+TikTok time that was short-form, per day, 30-day window
4. **Unexpected Places** — ranked list of stationary clusters not yet named
5. **Today summary** — emoji timeline view of the day (see [places.md](places.md))

Each one exercises a different template and proves the architecture. If we can ship these five cleanly, the rest is configuration.
