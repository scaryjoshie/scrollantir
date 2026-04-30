// Detail pane (bottom-right). Drill-down donut: L0 category → L1 project →
// L2 title. A small device-split donut sits beside it, always showing
// mac vs phone for the whole visit (orthogonal axis — doesn't re-filter
// with drill). Mac-precedence dedupe applied throughout: phone time only
// counts during minutes when no mac chunk overlaps, so concurrent
// foreground doesn't double-count.

import { useEffect, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { cn } from '@/lib/cn';
import type {
  PlaceVisit,
  TimelineEntry,
  TopicCategory,
  TopicChunk,
  TravelLeg,
} from './types';
import { useTodayLookups } from './lookups';

const ACTIVITY_LABEL: Record<string, string> = {
  walking: 'Walking',
  on_bicycle: 'Cycling',
  in_vehicle: 'In vehicle',
  running: 'Running',
  still: 'Stationary',
};

const CATEGORY_LABEL: Record<TopicCategory, string> = {
  work: 'Work',
  play: 'Play',
  neutral: 'Neutral',
};

// Top-level color when slicing by category (L0). Saturated, distinct.
const CATEGORY_BAR: Record<TopicCategory, string> = {
  work: '#5CB084',
  play: '#D9755C',
  neutral: '#A39E94',
};

// Per-category palettes used at L1 (projects) and L2 (titles). Keeps
// drill-in slices visually anchored to the category they came from.
const CATEGORY_PALETTES: Record<TopicCategory, string[]> = {
  work: ['#5C8AD9', '#5CB1A0', '#7AB55C', '#5CB8C7', '#9C7AD9', '#4A6FB8'],
  play: ['#E07B5C', '#E07B98', '#D9A35C', '#B85CD9', '#E0A35C', '#C75C7B'],
  neutral: ['#8E8B85', '#A39E94', '#7A7570', '#9C988F'],
};

// Device-pie colors. Distinct from category colors so the device donut
// reads as a separate axis at a glance.
const DEVICE_COLOR: Record<'mac' | 'phone', string> = {
  mac: '#4D6A8A',
  phone: '#D9A35C',
};

const DEVICE_LABEL: Record<'mac' | 'phone', string> = {
  mac: 'Mac',
  phone: 'Phone',
};

function hashWithin(palette: string[], key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

function fmtTime(iso: string): string {
  return format(parseISO(iso), 'h:mm a');
}

function fmtDuration(startIso: string, endIso: string): string {
  return humanize(parseISO(endIso).getTime() - parseISO(startIso).getTime());
}

// Live `now` tick — the open-visit subtitle counts up in 30s steps
// without needing a full data refetch.
function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function humanize(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return '<1m';
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function chunkMs(c: TopicChunk): number {
  return parseISO(c.end_ts).getTime() - parseISO(c.start_ts).getTime();
}

// ---------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------

// One bucket on a donut. `key` is what gets passed to the click handler
// (drill target — category slug, project slug, or full title). `category`
// drives color: at L0 it IS the slice; at L1/L2 the slices are colored
// from the locked-in category's palette so drill-in stays coherent.
type Slice = {
  key: string;
  label: string;
  ms: number;
  color: string;
  category: TopicCategory;
};

// Mac-precedence helper. Returns:
//   - `effectiveMs(c)` — chunk duration after subtracting any minutes
//     that overlap with the merged mac-coverage interval set (phone
//     chunks only; mac chunks return their raw duration).
//   - reused for both the project-side donut and the device-side donut
//     so both sum to the same total.
function macPrecedence(chunks: TopicChunk[]): {
  effectiveMs: (c: TopicChunk) => number;
} {
  const macIntervals: Array<[number, number]> = chunks
    .filter((c) => c.device === 'mac')
    .map((c): [number, number] => [
      parseISO(c.start_ts).getTime(),
      parseISO(c.end_ts).getTime(),
    ])
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of macIntervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  function effectiveMs(c: TopicChunk): number {
    if (c.device !== 'phone') return chunkMs(c);
    const cs = parseISO(c.start_ts).getTime();
    const ce = parseISO(c.end_ts).getTime();
    let effective = ce - cs;
    for (const [ms, me] of merged) {
      if (me <= cs || ms >= ce) continue;
      effective -= Math.min(me, ce) - Math.max(ms, cs);
      if (effective <= 0) return 0;
    }
    return effective;
  }
  return { effectiveMs };
}

// Group chunks by the L0/L1/L2 axis.
//
// `effectiveMs` MUST be the visit-scoped function (built from the FULL
// chunk list, not the drill-filtered subset). Otherwise drilling into
// 'play' inflates phone-play time that was actually concurrent with
// mac-work — the play subset alone has no mac coverage to dampen
// against, so the math silently lies. Computing once at the visit level
// keeps drill totals consistent with L0 totals.
function aggregate(
  chunks: TopicChunk[],
  groupBy: 'category' | 'project' | 'title',
  // Locked category at L1/L2 — controls slice palette. Ignored at L0.
  lockedCategory: TopicCategory | null,
  effectiveMs: (c: TopicChunk) => number,
): { slices: Slice[]; totalMs: number } {
  type Bucket = { ms: number; category: TopicCategory };
  const buckets = new Map<string, Bucket>();
  for (const c of chunks) {
    const ms = effectiveMs(c);
    if (ms <= 0) continue;
    const key =
      groupBy === 'category' ? c.category :
      groupBy === 'project'  ? c.project  :
                               c.title;
    const existing = buckets.get(key);
    if (existing) existing.ms += ms;
    else buckets.set(key, { ms, category: c.category });
  }
  const slices: Slice[] = Array.from(buckets.entries()).map(([key, b]) => {
    let color: string;
    let label: string;
    if (groupBy === 'category') {
      color = CATEGORY_BAR[key as TopicCategory];
      label = CATEGORY_LABEL[key as TopicCategory];
    } else {
      const palette = CATEGORY_PALETTES[lockedCategory ?? b.category];
      color = hashWithin(palette, key);
      label = key;
    }
    return { key, label, ms: b.ms, color, category: b.category };
  });
  slices.sort((a, b) => b.ms - a.ms);
  const totalMs = slices.reduce((s, x) => s + x.ms, 0);
  return { slices, totalMs };
}

// Device-axis aggregate — always uses ALL chunks (no drill filter).
// Reuses the visit-scoped `effectiveMs` so the donut total matches the
// main donut at L0.
function aggregateDevice(
  chunks: TopicChunk[],
  effectiveMs: (c: TopicChunk) => number,
): {
  slices: Slice[];
  totalMs: number;
} {
  const buckets = new Map<'mac' | 'phone', number>();
  for (const c of chunks) {
    const ms = effectiveMs(c);
    if (ms <= 0) continue;
    const dev = c.device ?? 'mac';
    buckets.set(dev, (buckets.get(dev) ?? 0) + ms);
  }
  const slices: Slice[] = Array.from(buckets.entries())
    .map(([dev, ms]) => ({
      key: dev,
      label: DEVICE_LABEL[dev],
      ms,
      color: DEVICE_COLOR[dev],
      category: 'neutral' as TopicCategory,
    }))
    .sort((a, b) => b.ms - a.ms);
  const totalMs = slices.reduce((s, x) => s + x.ms, 0);
  return { slices, totalMs };
}

// ---------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------

export default function DetailPane({
  entry,
  dayStartIso,
}: {
  entry: TimelineEntry | null;
  // The displayed day's start (always local 00:00). Visits whose true
  // start_ts lies before this get their "Since X" subtitle + live
  // duration clipped so a still-open overnight stay reads as
  // "Since 12:00 AM (continued) · 7h ongoing" instead of 16h.
  dayStartIso?: string;
}) {
  if (!entry) {
    return (
      <div className="px-6 py-5 text-sm text-ink-subtle">
        Select something on the timeline.
      </div>
    );
  }
  if (entry.kind === 'moment') {
    return (
      <div className="px-6 py-5">
        <Header title={entry.label} subtitle={fmtTime(entry.ts)} glyph={entry.glyph} />
        {entry.source_hint && (
          <div className="text-xs text-ink-subtle mt-3">
            From <Mono>{entry.source_hint}</Mono>
          </div>
        )}
      </div>
    );
  }
  // key={entry.id} forces remount on selection change so each entry's
  // drill state starts fresh — picking a new place_visit doesn't carry
  // over the previous one's "drilled into Work › scrollantir."
  if (entry.kind === 'place_visit')
    return <VisitDetail key={entry.id} visit={entry} dayStartIso={dayStartIso} />;
  if (entry.kind === 'travel_leg')
    return <LegDetail key={entry.id} leg={entry} />;
  return <ChunkDetail chunk={entry} />;
}

// ---------------------------------------------------------------------
// Visit / leg detail — share the drill panel via ChunkDrill
// ---------------------------------------------------------------------

function VisitDetail({
  visit,
  dayStartIso,
}: {
  visit: PlaceVisit;
  dayStartIso?: string;
}) {
  const { topicChunks } = useTodayLookups();
  const now = useNowTick();
  const chunks = useMemo(
    () =>
      topicChunks
        .filter((c) => c.parent_id === visit.id)
        .sort((a, b) => (a.start_ts < b.start_ts ? -1 : 1)),
    [topicChunks, visit.id],
  );

  const startedBeforeToday =
    !!dayStartIso && visit.start_ts < dayStartIso;
  const displayStart = startedBeforeToday ? dayStartIso! : visit.start_ts;

  const subtitle = visit.data.is_open
    ? startedBeforeToday
      ? `Since ${fmtTime(displayStart)} (continued) · ${humanize(
          now - parseISO(displayStart).getTime(),
        )} · ongoing`
      : `Since ${fmtTime(visit.start_ts)} · ${humanize(
          now - parseISO(visit.start_ts).getTime(),
        )} · ongoing`
    : `${fmtTime(visit.start_ts)} – ${fmtTime(visit.end_ts)} · ${fmtDuration(
        visit.start_ts,
        visit.end_ts,
      )}`;

  return (
    <div className="px-6 py-5 h-full overflow-y-auto">
      <Header
        title={visit.place?.name ?? 'Unknown place'}
        subtitle={subtitle}
        chip={visit.place?.category}
        live={visit.data.is_open}
      />
      <ChunkDrill chunks={chunks} />
    </div>
  );
}

function LegDetail({ leg }: { leg: TravelLeg }) {
  const { visitById, topicChunks } = useTodayLookups();
  const from = visitById[leg.data.from_visit_id];
  const to = visitById[leg.data.to_visit_id];
  const chunks = useMemo(
    () =>
      topicChunks
        .filter((c) => c.parent_id === leg.id)
        .sort((a, b) => (a.start_ts < b.start_ts ? -1 : 1)),
    [topicChunks, leg.id],
  );
  return (
    <div className="px-6 py-5 h-full overflow-y-auto">
      <Header
        title={`${from?.place?.name ?? '?'} → ${to?.place?.name ?? '?'}`}
        subtitle={`${fmtTime(leg.start_ts)} – ${fmtTime(leg.end_ts)} · ${fmtDuration(
          leg.start_ts,
          leg.end_ts,
        )}`}
        chip={ACTIVITY_LABEL[leg.data.dominant_activity]}
      />
      <div className="text-xs text-ink-subtle mt-3">
        {Math.round(leg.data.distance_m)} m straight-line ·{' '}
        {leg.data.reading_count} GPS sample{leg.data.reading_count === 1 ? '' : 's'}
      </div>
      <ChunkDrill chunks={chunks} />
    </div>
  );
}

function ChunkDetail({ chunk }: { chunk: TopicChunk }) {
  const { visitById, legById } = useTodayLookups();
  const parentVisit = visitById[chunk.parent_id];
  const parentLeg = parentVisit ? null : legById[chunk.parent_id];
  let chip: string | undefined;
  if (parentVisit) chip = parentVisit.place?.name;
  else if (parentLeg) chip = ACTIVITY_LABEL[parentLeg.data.dominant_activity];
  const palette = CATEGORY_PALETTES[chunk.category];
  const accent = hashWithin(palette, chunk.title);
  return (
    <div className="px-6 py-5">
      <Header
        title={chunk.title}
        subtitle={`${fmtTime(chunk.start_ts)} – ${fmtTime(chunk.end_ts)} · ${fmtDuration(
          chunk.start_ts,
          chunk.end_ts,
        )}`}
        chip={chip}
        accent={accent}
      />
      <div className="text-xs text-ink-subtle mt-3 flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: CATEGORY_BAR[chunk.category] }}
        />
        {CATEGORY_LABEL[chunk.category]} · {chunk.project}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// ChunkDrill — drill-down donut + breadcrumb + device companion
// ---------------------------------------------------------------------

type DrillPath = { category?: TopicCategory; project?: string };

function ChunkDrill({ chunks }: { chunks: TopicChunk[] }) {
  const [path, setPath] = useState<DrillPath>({});

  // Filter chunks by current drill — every level narrows the input,
  // then aggregation re-buckets the survivors at the next axis.
  const filtered = useMemo(() => {
    return chunks.filter(
      (c) =>
        (!path.category || c.category === path.category) &&
        (!path.project || c.project === path.project),
    );
  }, [chunks, path.category, path.project]);

  const groupBy: 'category' | 'project' | 'title' =
    !path.category ? 'category' : !path.project ? 'project' : 'title';

  const lockedCategory = path.category ?? null;
  const drillable = groupBy !== 'title';

  // Mac-precedence baseline computed ONCE against the full visit/leg
  // chunk set. Both donuts (project drill + device split) consume this
  // shared `effectiveMs` so totals stay consistent across drill levels.
  // Computing per-subset would let drilling into 'play' silently
  // inflate phone-play time that was concurrent with mac-work.
  const { effectiveMs } = useMemo(() => macPrecedence(chunks), [chunks]);

  const main = useMemo(
    () => aggregate(filtered, groupBy, lockedCategory, effectiveMs),
    [filtered, groupBy, lockedCategory, effectiveMs],
  );

  // Device pie always uses the full chunk set (visit/leg total) — it's
  // an orthogonal axis. Drilling into Work › scrollantir doesn't filter
  // it; that would conflate "what device dominates this visit" with
  // "what device dominates this drill subset."
  const device = useMemo(
    () => aggregateDevice(chunks, effectiveMs),
    [chunks, effectiveMs],
  );

  function onSliceClick(key: string) {
    if (!drillable) return;
    if (groupBy === 'category') setPath({ category: key as TopicCategory });
    else if (groupBy === 'project') setPath({ ...path, project: key });
  }

  function popTo(level: 'all' | 'category') {
    if (level === 'all') setPath({});
    else setPath({ category: path.category });
  }

  if (chunks.length === 0 || main.totalMs === 0) {
    return <div className="mt-5 text-sm text-ink-subtle">No activity recorded.</div>;
  }

  return (
    <div className="mt-5">
      <Breadcrumb path={path} onPopTo={popTo} />

      <div className="mt-3 flex items-start gap-6 flex-wrap">
        <DonutChart
          slices={main.slices}
          totalMs={main.totalMs}
          size={160}
          centerLabel={drillable ? 'click to drill' : 'titles'}
          onSliceClick={drillable ? onSliceClick : undefined}
        />
        <DonutChart
          slices={device.slices}
          totalMs={device.totalMs}
          size={96}
          centerLabel="device"
          // Device pie is read-only — orthogonal axis, not drillable.
          onSliceClick={undefined}
        />
        <DrillLegend
          slices={main.slices}
          totalMs={main.totalMs}
          drillable={drillable}
          onRowClick={onSliceClick}
        />
      </div>
    </div>
  );
}

function Breadcrumb({
  path,
  onPopTo,
}: {
  path: DrillPath;
  onPopTo: (level: 'all' | 'category') => void;
}) {
  if (!path.category) {
    // L0 — show the static label so the affordance for "you can drill"
    // is obvious without an explicit onboarding hint.
    return (
      <div className="text-xs text-ink-subtle uppercase tracking-wider font-semibold">
        By category
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={() => onPopTo('all')}
        className="text-ink-muted hover:text-ink underline-offset-2 hover:underline"
      >
        All
      </button>
      <span className="text-ink-subtle">›</span>
      {path.project ? (
        <>
          <button
            type="button"
            onClick={() => onPopTo('category')}
            className="text-ink-muted hover:text-ink underline-offset-2 hover:underline"
          >
            {CATEGORY_LABEL[path.category]}
          </button>
          <span className="text-ink-subtle">›</span>
          <span className="text-ink font-semibold">{path.project}</span>
        </>
      ) : (
        <span className="text-ink font-semibold">{CATEGORY_LABEL[path.category]}</span>
      )}
      <button
        type="button"
        onClick={() => onPopTo('all')}
        className="ml-2 text-ink-subtle hover:text-ink"
        aria-label="Clear drill"
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------
// Donut + Legend
// ---------------------------------------------------------------------

function DonutChart({
  slices,
  totalMs,
  size,
  centerLabel,
  onSliceClick,
}: {
  slices: Slice[];
  totalMs: number;
  size: number;
  centerLabel?: string;
  onSliceClick?: (key: string) => void;
}) {
  const cx = size / 2;
  const cy = size / 2;
  // Stroke + radius math: keep the stroked donut inside viewBox with a
  // small visual padding. Stroke scales with size for the small device
  // pie so it doesn't look spindly next to the main one.
  const strokeWidth = Math.max(14, size * 0.16);
  const padding = 4;
  const radius = size / 2 - strokeWidth / 2 - padding;
  const innerRadius = radius - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0 overflow-visible"
    >
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="transparent"
        stroke="rgb(var(--c-line))"
        strokeWidth={strokeWidth}
      />
      {slices.map((s) => {
        const fraction = s.ms / totalMs;
        const dashLength = circumference * fraction;
        const gap = Math.min(2, dashLength * 0.15);
        const slice = (
          <circle
            key={s.key}
            cx={cx}
            cy={cy}
            r={radius}
            fill="transparent"
            stroke={s.color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${Math.max(0, dashLength - gap)} ${circumference}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${cx} ${cy})`}
            className={onSliceClick ? 'cursor-pointer' : undefined}
            onClick={onSliceClick ? () => onSliceClick(s.key) : undefined}
          >
            <title>{`${s.label} · ${humanize(s.ms)}`}</title>
          </circle>
        );
        offset += dashLength;
        return slice;
      })}
      <text
        x={cx}
        y={cy - innerRadius * 0.05}
        textAnchor="middle"
        className="fill-ink"
        style={{ fontSize: innerRadius * 0.34, fontWeight: 600 }}
      >
        {humanize(totalMs)}
      </text>
      {centerLabel && (
        <text
          x={cx}
          y={cy + innerRadius * 0.4}
          textAnchor="middle"
          className="fill-ink-subtle"
          style={{ fontSize: innerRadius * 0.18 }}
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
}

function DrillLegend({
  slices,
  totalMs,
  drillable,
  onRowClick,
}: {
  slices: Slice[];
  totalMs: number;
  drillable: boolean;
  // Rows are click-targets (synonyms for slice-click) so users can pick
  // narrow slivers without aiming at a hairline.
  onRowClick: (key: string) => void;
}) {
  // Cap visible rows; remaining tail collapsed into "+N more" so a
  // 50-title L2 doesn't blow out the pane height.
  const MAX_ROWS = 12;
  const visible = slices.slice(0, MAX_ROWS);
  const hidden = slices.slice(MAX_ROWS);
  const hiddenMs = hidden.reduce((s, x) => s + x.ms, 0);

  return (
    <ul className="text-sm flex-1 min-w-[14rem] max-h-[280px] overflow-y-auto">
      {visible.map((s) => {
        const pct = Math.round((s.ms / totalMs) * 100);
        return (
          <li
            key={s.key}
            className={cn(
              'grid items-center gap-x-3 py-1 -mx-2 px-2 rounded',
              drillable && 'cursor-pointer hover:bg-paper-hover',
            )}
            style={{ gridTemplateColumns: 'auto 1fr auto auto' }}
            onClick={drillable ? () => onRowClick(s.key) : undefined}
          >
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{ background: s.color }}
            />
            <span className="text-ink truncate">{s.label}</span>
            <span className="text-ink-subtle tabular-nums text-xs justify-self-end">
              {humanize(s.ms)}
            </span>
            <span className="text-ink-subtle tabular-nums text-xs justify-self-end w-8 text-right">
              {pct}%
            </span>
          </li>
        );
      })}
      {hidden.length > 0 && (
        <li
          className="grid items-center gap-x-3 py-1 -mx-2 px-2 text-ink-subtle italic"
          style={{ gridTemplateColumns: 'auto 1fr auto auto' }}
        >
          <span />
          <span className="truncate">+{hidden.length} more</span>
          <span className="tabular-nums text-xs justify-self-end">
            {humanize(hiddenMs)}
          </span>
          <span className="tabular-nums text-xs justify-self-end w-8 text-right">
            {Math.round((hiddenMs / totalMs) * 100)}%
          </span>
        </li>
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------
// Header / Mono — unchanged from prior version
// ---------------------------------------------------------------------

function Header({
  title,
  subtitle,
  chip,
  glyph,
  accent,
  live,
}: {
  title: string;
  subtitle: string;
  chip?: string;
  glyph?: string;
  accent?: string;
  live?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      {(glyph || accent) && (
        <span
          className={cn(
            'shrink-0 w-9 h-9 rounded-lg grid place-items-center text-base',
            !accent && 'bg-paper-hover border border-line',
          )}
          style={accent ? { background: accent, color: 'white' } : undefined}
        >
          {glyph ?? '•'}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-ink truncate">{title}</h3>
          {live && (
            <span
              className="inline-flex items-center gap-1.5 shrink-0
                         text-xs font-medium text-success
                         bg-success-soft rounded-full px-2 py-0.5"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Live
            </span>
          )}
          {chip && (
            <span className="text-xs text-ink-muted bg-paper-hover border border-line rounded-full px-2 py-0.5 shrink-0">
              {chip}
            </span>
          )}
        </div>
        <div className="text-xs text-ink-subtle mt-0.5 tabular-nums">{subtitle}</div>
      </div>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-xs bg-paper-hover px-1 py-0.5 rounded">
      {children}
    </code>
  );
}
