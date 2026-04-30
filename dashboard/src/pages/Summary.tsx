// At-a-glance summary. Today / this-week toggle, four headline tiles,
// category donut, project bar, sleep strip.
//
// Data source: v_daily_summary + v_project_activity views (migration
// 0017). One small wire payload per page (1 row for "today", 7 for
// "week"). No raw chunk fetch — the views compute mac-precedence,
// awake clipping, and sleep aggregation server-side so /summary stays
// honest about the same numbers /today shows for the per-session drill.
//
// Honesty: where data is missing (no chunks, no user_active),
// "Tracking gap" / "Not enough data" — never fabricated. Per Tenet 1.
//
// Reuse: DonutPanel from @/components/Donut (extracted from DetailPane).

import { useMemo, useState } from 'react';
import { addDays, format, parseISO } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import { DonutPanel, humanizeMs } from '@/components/Donut';
import { BarChart, type BarItem } from '@/components/BarChart';
import { startOfLocalDay } from '@/components/DatePicker';
import { cn } from '@/lib/cn';
import {
  fetchDailySummary,
  fetchProjectActivity,
  type DailySummary,
  type ProjectActivity,
} from '@/lib/api';

type Range = 'today' | 'week';

// Category palette mirrors DetailPane.tsx — keep colors consistent
// across the dashboard so a slice that's "work" on /today is "work"
// on /summary too.
const CATEGORY_COLOR = {
  work: '#5CB084',
  play: '#D9755C',
  neutral: '#A39E94',
} as const;

const PROJECT_PALETTE = [
  '#5C8AD9', '#5CB1A0', '#7AB55C', '#5CB8C7', '#9C7AD9',
  '#4A6FB8', '#E07B5C', '#D9A35C', '#C75C7B', '#B85CD9',
];

function hashColor(palette: readonly string[], key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

// Local YYYY-MM-DD without UTC drift. format(d, 'yyyy-MM-dd') uses
// local TZ — what the views expect.
function ymd(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function rangeBounds(range: Range): { from: string; to: string; label: string } {
  const today = startOfLocalDay(new Date());
  if (range === 'today') {
    const t = ymd(today);
    return { from: t, to: t, label: format(today, 'EEEE, MMM d') };
  }
  // Week: today and the prior 6 days. Aligns with the user's natural
  // "rolling week" reading of trends rather than a calendar Mon-Sun
  // (which would feel arbitrary mid-week).
  const start = addDays(today, -6);
  return {
    from: ymd(start),
    to: ymd(today),
    label: `${format(start, 'MMM d')} – ${format(today, 'MMM d')}`,
  };
}

function sumField(rows: DailySummary[], k: keyof DailySummary): number {
  return rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
}

export default function SummaryPage() {
  const [range, setRange] = useState<Range>('today');
  const { from, to, label } = useMemo(() => rangeBounds(range), [range]);

  const summaryQ = useQuery({
    queryKey: ['daily_summary', from, to],
    queryFn: () => fetchDailySummary(from, to),
  });
  const projectQ = useQuery({
    queryKey: ['project_activity', from, to],
    queryFn: () => fetchProjectActivity(from, to),
  });

  const rows = summaryQ.data ?? [];
  const projects = projectQ.data ?? [];

  // Aggregate across rows. For "today" there's one row; for "week"
  // sums across the period.
  const agg = useMemo(() => {
    return {
      awake_s:           sumField(rows, 'awake_s'),
      free_s:            sumField(rows, 'free_s'),
      work_s:            sumField(rows, 'work_effective_s'),
      play_s:            sumField(rows, 'play_effective_s'),
      neutral_s:         sumField(rows, 'neutral_effective_s'),
      sleep_main_s:      sumField(rows, 'sleep_main_s'),
      phone_active_s:    sumField(rows, 'phone_active_s'),
      phone_effective_s: sumField(rows, 'phone_effective_s'),
      mac_active_s:      sumField(rows, 'mac_active_s'),
      visit_count:       sumField(rows, 'place_visit_count'),
      distinct_places:   range === 'today' ? (rows[0]?.distinct_places ?? 0)
                                           : sumField(rows, 'distinct_places'),
      travel_distance_m: sumField(rows, 'travel_distance_m'),
      sleep_disrupted:   sumField(rows, 'sleep_disrupted_count'),
    };
  }, [rows, range]);

  const isLoading = summaryQ.isLoading || projectQ.isLoading;
  const error = summaryQ.error || projectQ.error;

  // True empty: no rows for the selected range. The page still has
  // structure (toggle), but the cards say "Tracking gap" instead of
  // showing zero-everything tiles that read as a successful zero day.
  const noData = !isLoading && rows.length === 0;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <PageHeader
        title="At a glance"
        subtitle={label}
        right={<RangeToggle value={range} onChange={setRange} />}
      />

      {error ? (
        <div className="px-10 py-8">
          <EmptyState
            title="Couldn't load summary"
            body={error instanceof Error ? error.message : String(error)}
          />
        </div>
      ) : isLoading ? (
        <div className="px-10 py-8">
          <EmptyState title="Loading…" body="Aggregating your day." />
        </div>
      ) : noData ? (
        <div className="px-10 py-8">
          <EmptyState
            title="Tracking gap"
            body="No activity, sleep, or location data for this range. Either nothing was recorded, or the agent isn't running."
          />
        </div>
      ) : (
        <div className="px-10 py-8 space-y-8 max-w-6xl">
          {/* Headline tiles */}
          <section
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
          >
            <Tile
              label="Free"
              value={humanizeMs(agg.free_s * 1000)}
              hint="Awake time outside work + neutral"
              accent={agg.free_s === 0 ? 'muted' : 'accent'}
            />
            <Tile
              label="Work"
              value={humanizeMs(agg.work_s * 1000)}
              hint={pct(agg.work_s, agg.awake_s) + ' of awake time'}
            />
            <Tile
              label="Sleep"
              value={
                agg.sleep_main_s > 0
                  ? humanizeMs(agg.sleep_main_s * 1000)
                  : 'No sleep recorded'
              }
              hint={
                agg.sleep_main_s > 0
                  ? agg.sleep_disrupted > 0
                    ? `${agg.sleep_disrupted} disruption${agg.sleep_disrupted > 1 ? 's' : ''}`
                    : 'No disruptions'
                  : range === 'today' ? 'Tonight not yet derived' : '—'
              }
              accent={agg.sleep_main_s === 0 ? 'muted' : 'plain'}
            />
            <Tile
              label="Phone time"
              value={humanizeMs(agg.phone_effective_s * 1000)}
              hint={
                agg.phone_active_s > agg.phone_effective_s
                  ? `${humanizeMs(agg.phone_active_s * 1000)} raw, ${humanizeMs(
                      (agg.phone_active_s - agg.phone_effective_s) * 1000,
                    )} concurrent with Mac`
                  : 'Mac-precedence applied'
              }
            />
          </section>

          {/* Category donut + project bar, side by side on desktop */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <Card title="By category">
              <CategoryDonut agg={agg} />
            </Card>
            <Card title="Top projects">
              <ProjectBars projects={projects} totalActiveS={agg.work_s + agg.neutral_s + agg.play_s} />
            </Card>
          </section>

          {/* Sleep strip */}
          <section>
            <Card title="Sleep">
              <SleepStrip rows={rows} range={range} />
            </Card>
          </section>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Range toggle
// ---------------------------------------------------------------------

function RangeToggle({
  value,
  onChange,
}: {
  value: Range;
  onChange: (next: Range) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-line overflow-hidden bg-paper">
      {(['today', 'week'] as const).map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={cn(
            'px-3 py-1 text-sm capitalize transition-colors',
            value === r
              ? 'bg-paper-hover text-ink font-medium'
              : 'text-ink-muted hover:bg-paper-hover',
          )}
        >
          {r === 'today' ? 'Today' : 'This week'}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Tiles + cards
// ---------------------------------------------------------------------

function Tile({
  label,
  value,
  hint,
  accent = 'plain',
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: 'plain' | 'accent' | 'muted';
}) {
  return (
    <div
      className={cn(
        'rounded-card border bg-paper px-4 py-4',
        accent === 'accent' ? 'border-accent/30' : 'border-line',
      )}
    >
      <div className="text-xs uppercase tracking-wider text-ink-subtle font-semibold">
        {label}
      </div>
      <div
        className={cn(
          'mt-1.5 text-2xl tabular-nums',
          accent === 'muted' ? 'text-ink-subtle' : 'text-ink font-semibold',
        )}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-xs text-ink-subtle leading-snug">{hint}</div>
      )}
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-line bg-paper p-5">
      <div className="text-xs uppercase tracking-wider text-ink-subtle font-semibold mb-4">
        {title}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------
// Category donut
// ---------------------------------------------------------------------

function CategoryDonut({
  agg,
}: {
  agg: { work_s: number; play_s: number; neutral_s: number };
}) {
  const slices = [
    { key: 'work',    label: 'Work',    ms: agg.work_s    * 1000, color: CATEGORY_COLOR.work },
    { key: 'play',    label: 'Play',    ms: agg.play_s    * 1000, color: CATEGORY_COLOR.play },
    { key: 'neutral', label: 'Neutral', ms: agg.neutral_s * 1000, color: CATEGORY_COLOR.neutral },
  ].filter((s) => s.ms > 0);
  const totalMs = slices.reduce((t, s) => t + s.ms, 0);
  if (totalMs === 0) {
    return (
      <div className="text-sm text-ink-subtle">No classified activity yet.</div>
    );
  }
  return <DonutPanel slices={slices} totalMs={totalMs} size={150} />;
}

// ---------------------------------------------------------------------
// Project bars — top N projects ranked by total time over the period.
// Renders as a shared horizontal BarChart so the visual idiom matches
// the project ranking on /trends.
// ---------------------------------------------------------------------

function ProjectBars({
  projects,
  totalActiveS,
}: {
  projects: ProjectActivity[];
  totalActiveS: number;
}) {
  // Aggregate across days (week mode sends multiple rows per project).
  const byProject = useMemo(() => {
    const m = new Map<string, { name: string; total_s: number; chunks: number }>();
    for (const p of projects) {
      const cur = m.get(p.project_slug) ?? {
        name: p.project_name ?? p.project_slug,
        total_s: 0,
        chunks: 0,
      };
      cur.total_s += p.total_s;
      cur.chunks += p.chunk_count;
      m.set(p.project_slug, cur);
    }
    return Array.from(m.entries())
      .map(([slug, v]) => ({ slug, ...v }))
      .sort((a, b) => b.total_s - a.total_s)
      .slice(0, 8);
  }, [projects]);

  if (byProject.length === 0) {
    return (
      <div className="text-sm text-ink-subtle">
        No project-tagged activity yet.
      </div>
    );
  }

  // Bar scale uses the largest project as 100% — relative ranking is
  // easier to read than absolute % of awake. Tooltip shows absolute
  // share for context.
  const items: BarItem[] = byProject.map((p) => {
    const pctOfTotal = totalActiveS > 0 ? (p.total_s / totalActiveS) * 100 : 0;
    return {
      key: p.slug,
      label: p.name,
      value: p.total_s,
      color: hashColor(PROJECT_PALETTE, p.slug),
      tooltip: `${humanizeMs(p.total_s * 1000)} · ${pctOfTotal.toFixed(1)}% of active time`,
    };
  });

  return (
    <BarChart
      orientation="horizontal"
      items={items}
      valueFormat={(s) => humanizeMs(s * 1000)}
    />
  );
}

// ---------------------------------------------------------------------
// Sleep chart — one vertical bar per night in the period. Y axis is
// sleep duration in hours; bar color encodes whether the night had
// any deriver-flagged disruptions. Aligned to /trends's SleepTrend so
// a night reads identically across the two pages.
//
// User feedback (2026-04-30): the previous "horizontal row of cards"
// rendering buried the comparison. A bar chart makes nights legible
// at a glance; tracking gaps still render as dashed empty placeholders
// (Tenet 1) rather than vanishing from the row.
// ---------------------------------------------------------------------

// Sleep palette — same hex as /trends so disrupted vs. undisrupted
// reads identically across the two pages.
const SLEEP_COLOR = {
  ok: '#7DB98A',         // no disruptions
  disrupted: '#D9A35C',  // at least one
} as const;

// 8h reference matches /trends (`SleepTrend.REFERENCE_S`). A familiar
// point of comparison rather than an observed-data magic number; see
// Tenet 4 — we can't tie a target to one user without a population
// study, so the explicit "reference" framing is the honest path.
const SLEEP_REFERENCE_S = 8 * 3600;

// Format seconds as "7h 23m" / "7h" for sleep value labels.
function fmtSleep(s: number): string {
  if (s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function SleepStrip({
  rows,
  range,
}: {
  rows: DailySummary[];
  range: Range;
}) {
  const items: BarItem[] = useMemo(
    () =>
      rows.map((r) => {
        const disrupted = r.sleep_disrupted_count;
        const dayLabel = format(parseISO(r.local_date), 'EEE');
        const dateLabel = format(parseISO(r.local_date), 'M/d');
        const tooltip =
          r.sleep_main_s > 0
            ? `${fmtSleep(r.sleep_main_s)}` +
              (disrupted > 0
                ? ` · ${disrupted} disruption${disrupted > 1 ? 's' : ''}`
                : '')
            : 'No sleep recorded';
        return {
          key: r.local_date,
          label: dayLabel,
          sublabel: dateLabel,
          value: r.sleep_main_s,
          color: disrupted === 0 ? SLEEP_COLOR.ok : SLEEP_COLOR.disrupted,
          tooltip,
        };
      }),
    [rows],
  );

  const hasAny = rows.some((r) => r.sleep_main_s > 0);
  if (!hasAny) {
    return (
      <div className="text-sm text-ink-subtle">
        No sleep recorded for this range.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <BarChart
        orientation="vertical"
        items={items}
        // Scale to 10h so an under-target night reads as visibly short
        // and a long night still has headroom. The 8h reference line
        // makes the target visible without baking it into the scale.
        maxValue={10 * 3600}
        referenceValue={SLEEP_REFERENCE_S}
        height={range === 'today' ? 100 : 80}
        valueFormat={fmtSleep}
        emptyLabel="none"
      />
      <div className="flex items-center gap-x-4 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{ background: SLEEP_COLOR.ok }}
          />
          Undisrupted
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm"
            style={{ background: SLEEP_COLOR.disrupted }}
          />
          Disrupted
        </span>
        <span className="ml-auto text-[10px] text-ink-subtle">
          Dashed line at 8h reference
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function pct(num: number, den: number): string {
  if (den <= 0) return '—';
  const p = (num / den) * 100;
  if (p < 1 && num > 0) return '<1%';
  return `${Math.round(p)}%`;
}
