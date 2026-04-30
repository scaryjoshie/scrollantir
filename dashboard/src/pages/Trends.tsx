// Weekly trends. Stacked category bars per day, top projects ranked
// over the period, sleep duration trend.
//
// Same data source as /summary: v_daily_summary + v_project_activity.
// One small wire payload (7 days x 2 views).
//
// Honesty (Tenet 1): days with no rows render an explicit empty cell;
// days with no sleep render the cell but flag "No sleep recorded".

import { useMemo, useState } from 'react';
import { addDays, format, parseISO } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/PageHeader';
import EmptyState from '@/components/EmptyState';
import { humanizeMs } from '@/components/Donut';
import { BarChart, type BarItem } from '@/components/BarChart';
import { startOfLocalDay } from '@/components/DatePicker';
import { cn } from '@/lib/cn';
import {
  fetchDailySummary,
  fetchProjectActivity,
  type DailySummary,
  type ProjectActivity,
} from '@/lib/api';

type Span = 7 | 14 | 30;

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

function ymd(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

// Build the date spine for the requested span. The view only returns
// rows where data exists — we keep the spine local so empty days
// render as "Tracking gap" cells instead of silently disappearing.
function dateSpine(span: Span): string[] {
  const today = startOfLocalDay(new Date());
  const out: string[] = [];
  for (let i = span - 1; i >= 0; i--) out.push(ymd(addDays(today, -i)));
  return out;
}

export default function TrendsPage() {
  const [span, setSpan] = useState<Span>(7);
  const spine = useMemo(() => dateSpine(span), [span]);
  const from = spine[0];
  const to = spine[spine.length - 1];

  const summaryQ = useQuery({
    queryKey: ['daily_summary', from, to],
    queryFn: () => fetchDailySummary(from, to),
  });
  const projectQ = useQuery({
    queryKey: ['project_activity', from, to],
    queryFn: () => fetchProjectActivity(from, to),
  });

  // Map view rows by date for O(1) join with the spine.
  const byDate = useMemo(() => {
    const m = new Map<string, DailySummary>();
    for (const r of summaryQ.data ?? []) m.set(r.local_date, r);
    return m;
  }, [summaryQ.data]);

  const isLoading = summaryQ.isLoading || projectQ.isLoading;
  const error = summaryQ.error || projectQ.error;
  const hasAnyRow = (summaryQ.data ?? []).length > 0;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <PageHeader
        title="Trends"
        subtitle={`${format(parseISO(from), 'MMM d')} – ${format(parseISO(to), 'MMM d')}`}
        right={<SpanToggle value={span} onChange={setSpan} />}
      />

      {error ? (
        <div className="px-10 py-8">
          <EmptyState
            title="Couldn't load trends"
            body={error instanceof Error ? error.message : String(error)}
          />
        </div>
      ) : isLoading ? (
        <div className="px-10 py-8">
          <EmptyState title="Loading…" body={`Aggregating ${span} days.`} />
        </div>
      ) : !hasAnyRow ? (
        <div className="px-10 py-8">
          <EmptyState
            title="Tracking gap"
            body="No rows in the selected range. Either nothing was recorded, or the agent hasn't run yet."
          />
        </div>
      ) : (
        <div className="px-10 py-8 space-y-8 max-w-6xl">
          <Card title="Category time per day">
            <CategoryStack spine={spine} byDate={byDate} />
          </Card>

          <Card title="Top projects over period">
            <ProjectRanking projects={projectQ.data ?? []} />
          </Card>

          <Card title="Sleep duration">
            <SleepTrend spine={spine} byDate={byDate} />
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Span toggle
// ---------------------------------------------------------------------

function SpanToggle({
  value,
  onChange,
}: {
  value: Span;
  onChange: (next: Span) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-line overflow-hidden bg-paper">
      {([7, 14, 30] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={cn(
            'px-3 py-1 text-sm transition-colors',
            value === s
              ? 'bg-paper-hover text-ink font-medium'
              : 'text-ink-muted hover:bg-paper-hover',
          )}
        >
          {s}d
        </button>
      ))}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
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
// Category stack — one stacked bar per day. Bar height encodes
// awake_s, segments are work/play/neutral effective_s.
//
// Bars are individually scaled within a column rather than to a
// global max — this prefers READABILITY (every bar shows internal
// proportions) over comparability (you can't tell from height alone
// which day was longer). The duration label under each bar exists for
// the comparable read; the visual is the proportional read.
//
// If global comparability becomes important, switch to per-bar height
// proportional to awake_s with a max-100% fill cap.
// ---------------------------------------------------------------------

function CategoryStack({
  spine,
  byDate,
}: {
  spine: string[];
  byDate: Map<string, DailySummary>;
}) {
  // Find the max awake_s in the period; use as the bar-height scale so
  // shorter days look shorter.
  const maxAwake = Math.max(
    1,
    ...spine.map((d) => byDate.get(d)?.awake_s ?? 0),
  );

  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${spine.length}, minmax(0, 1fr))` }}
    >
      {spine.map((date) => {
        const row = byDate.get(date);
        const dayLabel = format(parseISO(date), 'EEE');
        const dateLabel = format(parseISO(date), 'M/d');

        if (!row || row.awake_s === 0) {
          return (
            <div key={date} className="flex flex-col items-center gap-1.5 min-w-0">
              <div className="text-[11px] text-ink-subtle">{dayLabel}</div>
              <div className="text-[10px] text-ink-subtle">{dateLabel}</div>
              <div className="w-full h-[140px] rounded-md bg-paper-panel border border-dashed border-line flex items-center justify-center">
                <span className="text-[10px] text-ink-subtle italic rotate-90 sm:rotate-0">
                  no data
                </span>
              </div>
              <div className="text-[10px] text-ink-subtle">—</div>
            </div>
          );
        }

        const h = (row.awake_s / maxAwake) * 140;
        const total = row.work_effective_s + row.play_effective_s + row.neutral_effective_s;
        // The remainder of awake is "free" — non-classified time that
        // wasn't one of the three categories. Render as paper-panel
        // (transparent) at the top of the stack so the bar shows true
        // proportion of awake_s that was classified.
        const free_s = Math.max(0, row.awake_s - total);

        return (
          <div key={date} className="flex flex-col items-center gap-1.5 min-w-0">
            <div className="text-[11px] text-ink-subtle">{dayLabel}</div>
            <div className="text-[10px] text-ink-subtle">{dateLabel}</div>
            <div
              className="w-full rounded-md overflow-hidden border border-line"
              style={{ height: `${h}px`, background: 'rgb(var(--c-paper-panel))' }}
              title={
                `${humanizeMs(row.awake_s * 1000)} awake · ` +
                `${humanizeMs(row.work_effective_s * 1000)} work · ` +
                `${humanizeMs(row.play_effective_s * 1000)} play · ` +
                `${humanizeMs(row.neutral_effective_s * 1000)} neutral`
              }
            >
              <div className="flex flex-col h-full">
                {free_s > 0 && (
                  <Segment seconds={free_s} total={row.awake_s} color="transparent" border />
                )}
                <Segment seconds={row.neutral_effective_s} total={row.awake_s} color={CATEGORY_COLOR.neutral} />
                <Segment seconds={row.play_effective_s}    total={row.awake_s} color={CATEGORY_COLOR.play} />
                <Segment seconds={row.work_effective_s}    total={row.awake_s} color={CATEGORY_COLOR.work} />
              </div>
            </div>
            <div className="text-[10px] text-ink tabular-nums">
              {humanizeMs(row.awake_s * 1000)}
            </div>
          </div>
        );
      })}
      {/* Legend */}
      <div className="col-span-full flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs text-ink-muted">
        <Swatch color={CATEGORY_COLOR.work}    label="Work" />
        <Swatch color={CATEGORY_COLOR.play}    label="Play" />
        <Swatch color={CATEGORY_COLOR.neutral} label="Neutral" />
        <Swatch color="rgb(var(--c-paper-panel))" border label="Unclassified awake" />
      </div>
    </div>
  );
}

function Segment({
  seconds,
  total,
  color,
  border = false,
}: {
  seconds: number;
  total: number;
  color: string;
  border?: boolean;
}) {
  if (seconds <= 0 || total <= 0) return null;
  const pct = (seconds / total) * 100;
  return (
    <div
      style={{
        flex: `${pct} 0 0`,
        background: color,
        borderTop: border ? '1px dashed rgb(var(--c-line))' : undefined,
      }}
    />
  );
}

function Swatch({
  color,
  label,
  border,
}: {
  color: string;
  label: string;
  border?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block w-3 h-3 rounded-sm"
        style={{
          background: color,
          border: border ? '1px dashed rgb(var(--c-line))' : undefined,
        }}
      />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------
// Project ranking — top projects across the period, rendered as a
// shared horizontal BarChart so /summary and /trends look identical
// where they overlap. Chunk count rides along as the row caption.
// ---------------------------------------------------------------------

function ProjectRanking({ projects }: { projects: ProjectActivity[] }) {
  const grouped = useMemo(() => {
    const m = new Map<
      string,
      { name: string; total_s: number; chunks: number }
    >();
    for (const p of projects) {
      const cur =
        m.get(p.project_slug) ??
        {
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
      .sort((a, b) => b.total_s - a.total_s);
  }, [projects]);

  if (grouped.length === 0) {
    return (
      <div className="text-sm text-ink-subtle">
        No project-tagged activity in this range.
      </div>
    );
  }

  const items: BarItem[] = grouped.map((p) => ({
    key: p.slug,
    label: p.name,
    value: p.total_s,
    color: hashColor(PROJECT_PALETTE, p.slug),
    tooltip: `${humanizeMs(p.total_s * 1000)} · ${p.chunks} chunk${p.chunks === 1 ? '' : 's'}`,
    caption: `${p.chunks} ${p.chunks === 1 ? 'chunk' : 'chunks'}`,
  }));

  return (
    <BarChart
      orientation="horizontal"
      items={items}
      valueFormat={(s) => humanizeMs(s * 1000)}
    />
  );
}

// ---------------------------------------------------------------------
// Sleep trend — vertical BarChart of nightly sleep duration. Shares
// the same component (and the same SLEEP_COLOR palette) as /summary
// so the two pages render a night identically. Tracking gaps render
// as dashed empty placeholders rather than vanishing (Tenet 1).
// ---------------------------------------------------------------------

// Sleep palette — duplicated here AND on /summary intentionally. The
// hex strings are the canonical "undisrupted = green, disrupted =
// amber" pair; if either page diverges in the future, callers should
// reconcile to the same palette rather than introducing a third hue.
const SLEEP_COLOR = {
  ok: '#7DB98A',
  disrupted: '#D9A35C',
} as const;

// 8h reference matches /summary. See Tenet 4 — we can't tie a target
// to one user without a study, so the explicit "reference" framing
// (rather than a personal target) is the honest path.
const SLEEP_REFERENCE_S = 8 * 3600;

function fmtSleep(s: number): string {
  if (s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function SleepTrend({
  spine,
  byDate,
}: {
  spine: string[];
  byDate: Map<string, DailySummary>;
}) {
  const items: BarItem[] = useMemo(
    () =>
      spine.map((date) => {
        const row = byDate.get(date);
        const sleepS = row?.sleep_main_s ?? 0;
        const disrupted = row?.sleep_disrupted_count ?? 0;
        const dayLabel = format(parseISO(date), 'EEE');
        const dateLabel = format(parseISO(date), 'M/d');
        const tooltip =
          sleepS > 0
            ? `${fmtSleep(sleepS)}` +
              (disrupted > 0
                ? ` · ${disrupted} disruption${disrupted > 1 ? 's' : ''}`
                : '')
            : 'No sleep recorded';
        return {
          key: date,
          label: dayLabel,
          sublabel: dateLabel,
          value: sleepS,
          color: disrupted === 0 ? SLEEP_COLOR.ok : SLEEP_COLOR.disrupted,
          tooltip,
        };
      }),
    [spine, byDate],
  );

  const anySleep = spine.some((d) => (byDate.get(d)?.sleep_main_s ?? 0) > 0);
  if (!anySleep) {
    return (
      <div className="text-sm text-ink-subtle">
        No sleep recorded in this range.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <BarChart
        orientation="vertical"
        items={items}
        // Scale to 10h — leaves headroom above the 8h reference line so
        // a long night doesn't peg the top. /summary uses the same scale.
        maxValue={10 * 3600}
        referenceValue={SLEEP_REFERENCE_S}
        height={80}
        valueFormat={fmtSleep}
        emptyLabel="none"
      />
      <div className="flex items-center gap-x-4 text-xs text-ink-muted">
        <Swatch color={SLEEP_COLOR.ok} label="Undisrupted" />
        <Swatch color={SLEEP_COLOR.disrupted} label="Disrupted" />
        <span className="ml-auto text-[10px] text-ink-subtle">
          Dashed line at 8h reference
        </span>
      </div>
    </div>
  );
}
