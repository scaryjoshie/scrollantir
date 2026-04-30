// Detail pane (bottom-right). Layout:
//   ┌──────────────────────────────────────┐
//   │ [Header]                             │
//   │                                      │
//   │  Category pie + legend │ Device pie  │
//   │                        │ + legend    │
//   │ ─────── (drill panel appears ─────── │
//   │  on category click) ─────────────── │
//   │  Breadcrumb                          │
//   │  Project pie + legend (or titles)    │
//   └──────────────────────────────────────┘
//
// L0 = category (work / play / neutral). Click → L1.
// L1 = projects within picked category. Click project → L2.
// L2 = exact window titles within (category, project) OR (category) when
//      L1 was auto-skipped.
//
// Auto-skip: when a category has ≤1 distinct project, L1 is skipped —
// clicking 'Play' goes straight to titles instead of forcing the user
// through a single-slice "misc" project view.

import { useEffect, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import type {
  PlaceVisit,
  TimelineEntry,
  TopicCategory,
  TopicChunk,
  TravelLeg,
} from './types';
import { useTodayLookups } from './lookups';
import { fetchProjectChunksForSpan } from '@/lib/api';
import { useProjects, type ProjectsLookup } from '@/lib/useProjects';
import { usePlaceLabels } from '@/lib/usePlaceLabels';

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

// Top-level category palette (L0 only).
const CATEGORY_BAR: Record<TopicCategory, string> = {
  work: '#5CB084',
  play: '#D9755C',
  neutral: '#A39E94',
};

// Per-category palettes for L1 (projects) and L2 (titles). Keeps drill-in
// slices visually anchored to the category they came from.
const CATEGORY_PALETTES: Record<TopicCategory, string[]> = {
  work: ['#5C8AD9', '#5CB1A0', '#7AB55C', '#5CB8C7', '#9C7AD9', '#4A6FB8'],
  play: ['#E07B5C', '#E07B98', '#D9A35C', '#B85CD9', '#E0A35C', '#C75C7B'],
  neutral: ['#8E8B85', '#A39E94', '#7A7570', '#9C988F'],
};

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

type Slice = {
  key: string;
  label: string;
  ms: number;
  color: string;
  category: TopicCategory;
};

// Mac-precedence: phone time only counts during minutes when no mac chunk
// overlaps. Computed ONCE per visit/leg and reused across drill levels —
// per-subset computation would let drilling into 'play' silently inflate
// phone-play time concurrent with mac-work.
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

function aggregate(
  chunks: TopicChunk[],
  groupBy: 'category' | 'project' | 'title',
  lockedCategory: TopicCategory | null,
  effectiveMs: (c: TopicChunk) => number,
  projects?: ProjectsLookup,
): { slices: Slice[]; totalMs: number } {
  type Bucket = { ms: number; category: TopicCategory };
  const buckets = new Map<string, Bucket>();
  for (const c of chunks) {
    const ms = effectiveMs(c);
    if (ms <= 0) continue;
    let key: string;
    if (groupBy === 'category') key = c.category;
    else if (groupBy === 'project') {
      // Null project under tree-model means "no project" (non-work
      // chunk). Skip — the drill panel for project-grouping should
      // only ever show real projects. Auto-skip handles the case
      // where a category has no real projects.
      if (c.project == null) continue;
      key = c.project;
    } else {
      key = c.title;
    }
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
      // For project group-by, swap slug → curated `name` so the legend
      // reads "Scrollantir" instead of "scrollantir". Falls back to the
      // slug (via byName) when the project isn't in the table — better
      // to display the slug than an empty cell.
      label = groupBy === 'project' && projects ? projects.byName(key) : key;
    }
    return { key, label, ms: b.ms, color, category: b.category };
  });
  slices.sort((a, b) => b.ms - a.ms);
  const totalMs = slices.reduce((s, x) => s + x.ms, 0);
  return { slices, totalMs };
}

function aggregateDevice(
  chunks: TopicChunk[],
  effectiveMs: (c: TopicChunk) => number,
): { slices: Slice[]; totalMs: number } {
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
// SVG arc helpers — used for individually-clickable slice paths.
// The previous stroke-dasharray approach rendered each slice as a full
// circle whose stroke happened to be visible in only an arc range; the
// LAST drawn circle covered every other circle's hit area so clicks
// always routed to the smallest (last) slice. Real arc paths fix this.
// ---------------------------------------------------------------------

function polarToCart(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): [number, number] {
  // angleDeg: 0 = 12 o'clock, increasing clockwise.
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function singleArcPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const [x1o, y1o] = polarToCart(cx, cy, outerR, startAngleDeg);
  const [x2o, y2o] = polarToCart(cx, cy, outerR, endAngleDeg);
  const [x1i, y1i] = polarToCart(cx, cy, innerR, endAngleDeg);
  const [x2i, y2i] = polarToCart(cx, cy, innerR, startAngleDeg);
  const largeArc = endAngleDeg - startAngleDeg > 180 ? 1 : 0;
  return [
    `M ${x1o} ${y1o}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2o} ${y2o}`,
    `L ${x1i} ${y1i}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2i} ${y2i}`,
    'Z',
  ].join(' ');
}

// Public arc helper. Splits any sweep > 180° into two sub-arcs so
// SVG `A` never has near-coincident endpoints (which renders as a
// degenerate sliver or invisible). Two M…Z subpaths concatenated
// share a single fill — visually one slice. Without this, a 99% slice
// (sweep ~357°) would either fail to render or render as a thin chord.
function arcPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const sweep = endAngleDeg - startAngleDeg;
  if (sweep <= 180) {
    return singleArcPath(cx, cy, outerR, innerR, startAngleDeg, endAngleDeg);
  }
  const mid = startAngleDeg + sweep / 2;
  return [
    singleArcPath(cx, cy, outerR, innerR, startAngleDeg, mid),
    singleArcPath(cx, cy, outerR, innerR, mid, endAngleDeg),
  ].join(' ');
}

// ---------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------

export default function DetailPane({
  entry,
  dayStartIso,
}: {
  entry: TimelineEntry | null;
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
  // drill state starts fresh.
  if (entry.kind === 'place_visit')
    return <VisitDetail key={entry.id} visit={entry} dayStartIso={dayStartIso} />;
  if (entry.kind === 'travel_leg')
    return <LegDetail key={entry.id} leg={entry} />;
  if (entry.kind === 'sleep') return <SleepDetail key={entry.id} sleep={entry} />;
  return <ChunkDetail chunk={entry} />;
}

// ---------------------------------------------------------------------
// Visit / leg — share ChunkDrill
// ---------------------------------------------------------------------

function VisitDetail({
  visit,
  dayStartIso,
}: {
  visit: PlaceVisit;
  dayStartIso?: string;
}) {
  const now = useNowTick();
  const placeLabels = usePlaceLabels();
  // Lazy-fetch chunks whose start_ts falls within this visit's span.
  // Uses the indexed (source, start_ts) — O(log N) regardless of total
  // chunk corpus. React Query caches per visit.id so re-selecting is
  // instant; first click pays one ~120ms RTT.
  const chunksQ = useQuery({
    queryKey: ['chunks-by-span', visit.id],
    queryFn: () => fetchProjectChunksForSpan(visit.start_ts, visit.end_ts),
    staleTime: 5 * 60 * 1000,
  });
  const chunks = useMemo(
    () =>
      (chunksQ.data ?? []).slice().sort((a, b) =>
        a.start_ts < b.start_ts ? -1 : 1,
      ),
    [chunksQ.data],
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
        title={placeLabels.display(visit.place?.name)}
        subtitle={subtitle}
        chip={visit.place?.category}
        live={visit.data.is_open}
      />
      <ChunkDrill chunks={chunks} />
    </div>
  );
}

function LegDetail({ leg }: { leg: TravelLeg }) {
  const { visitById } = useTodayLookups();
  const placeLabels = usePlaceLabels();
  const from = visitById[leg.data.from_visit_id];
  const to = visitById[leg.data.to_visit_id];
  // Lazy-fetch chunks whose start_ts falls within this leg's span.
  // Same indexing story as VisitDetail.
  const chunksQ = useQuery({
    queryKey: ['chunks-by-span', leg.id],
    queryFn: () => fetchProjectChunksForSpan(leg.start_ts, leg.end_ts),
    staleTime: 5 * 60 * 1000,
  });
  const chunks = useMemo(
    () =>
      (chunksQ.data ?? []).slice().sort((a, b) =>
        a.start_ts < b.start_ts ? -1 : 1,
      ),
    [chunksQ.data],
  );
  return (
    <div className="px-6 py-5 h-full overflow-y-auto">
      <Header
        title={`${placeLabels.display(from?.place?.name)} → ${placeLabels.display(to?.place?.name)}`}
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

function SleepDetail({ sleep }: { sleep: import('./types').Sleep }) {
  const totalMin = Math.round(sleep.provenance.duration_minutes);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const dur = h === 0 ? `${m} min` : m === 0 ? `${h}h` : `${h}h ${m}m`;
  const isNap = sleep.data.kind === 'nap';
  return (
    <div className="px-6 py-5 h-full overflow-y-auto">
      <Header
        title={isNap ? `Napped ${dur}` : `Slept ${dur}`}
        subtitle={`${fmtTime(sleep.start_ts)} – ${fmtTime(sleep.end_ts)} · ${dur}`}
        glyph={isNap ? '😴' : '🌙'}
      />
      <div className="mt-4 grid grid-cols-2 gap-y-2 gap-x-6 text-sm">
        <div className="text-ink-subtle">Onset</div>
        <div className="text-ink tabular-nums">{fmtTime(sleep.start_ts)}</div>
        <div className="text-ink-subtle">Wake</div>
        <div className="text-ink tabular-nums">
          {sleep.provenance.wake_local_time?.slice(0, 5) ?? fmtTime(sleep.end_ts)}
        </div>
        <div className="text-ink-subtle">Disruptions</div>
        <div className="text-ink tabular-nums">
          {sleep.provenance.disrupted_count}
          {sleep.provenance.disrupted_count > 0 && (
            <span className="text-ink-subtle">
              {' '}(brief activity merged into the silence)
            </span>
          )}
        </div>
        <div className="text-ink-subtle">Confidence</div>
        <div className="text-ink tabular-nums">
          {Math.round(sleep.data.confidence * 100)}%
        </div>
      </div>
      <div className="mt-3 text-xs text-ink-subtle">
        From <Mono>sleep/v1</Mono>
      </div>
    </div>
  );
}

function ChunkDetail({ chunk }: { chunk: TopicChunk }) {
  const { visitById, legById } = useTodayLookups();
  const projects = useProjects();
  const placeLabels = usePlaceLabels();
  const parentVisit = visitById[chunk.parent_id];
  const parentLeg = parentVisit ? null : legById[chunk.parent_id];
  let chip: string | undefined;
  if (parentVisit) chip = placeLabels.display(parentVisit.place?.name);
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
        {CATEGORY_LABEL[chunk.category]}
        {chunk.project && chunk.project !== 'personal' && chunk.project !== 'misc' && (
          <> · {projects.byName(chunk.project)}</>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// ChunkDrill — top row + drill panel
// ---------------------------------------------------------------------

// State shape:
//   L0   : nothing drilled (top pies are the whole story)
//   L1   : category picked, projects-within-category in drill panel
//   L2P  : category + project picked, titles-in-(cat,project)
//   L2C  : category picked, L1 was auto-skipped, titles-in-category
type DrillState =
  | { level: 'L0' }
  | { level: 'L1'; category: TopicCategory }
  | { level: 'L2P'; category: TopicCategory; project: string }
  | { level: 'L2C'; category: TopicCategory };

function ChunkDrill({ chunks }: { chunks: TopicChunk[] }) {
  const [state, setState] = useState<DrillState>({ level: 'L0' });
  // Projects table lookup — used to render the L1 project legend with
  // curated names instead of slugs, and to label the breadcrumb. Cached
  // forever via React Query so re-mounting on selection change is free.
  const projects = useProjects();

  const { effectiveMs } = useMemo(() => macPrecedence(chunks), [chunks]);

  // Top row aggregations — always over the full chunk set.
  const categoryAgg = useMemo(
    () => aggregate(chunks, 'category', null, effectiveMs),
    [chunks, effectiveMs],
  );
  const deviceAgg = useMemo(
    () => aggregateDevice(chunks, effectiveMs),
    [chunks, effectiveMs],
  );

  // Drill-panel content depends on state level.
  const drill = useMemo(() => {
    if (state.level === 'L0') return null;
    let filtered: TopicChunk[];
    let groupBy: 'project' | 'title';
    if (state.level === 'L1') {
      filtered = chunks.filter((c) => c.category === state.category);
      groupBy = 'project';
    } else if (state.level === 'L2P') {
      filtered = chunks.filter(
        (c) => c.category === state.category && c.project === state.project,
      );
      groupBy = 'title';
    } else {
      filtered = chunks.filter((c) => c.category === state.category);
      groupBy = 'title';
    }
    return aggregate(filtered, groupBy, state.category, effectiveMs, projects);
  }, [chunks, state, effectiveMs, projects]);

  // Click handler for category slice. Auto-skips L1 ONLY when the
  // category has zero real projects to drill into — clicking 'Play'
  // (typically all 'personal'/null) goes straight to titles instead
  // of bouncing through a single-slice "misc" project view.
  //
  // Even ONE real project earns the L1 step: the user wants to drill
  // into "scrollantir within Neutral" specifically, not be force-
  // routed past it. Previously the threshold was `<= 1` which silently
  // ate that step.
  //
  // The project count uses `effectiveMs(c) > 0`, not raw chunks, so a
  // phone chunk fully covered by Mac (effective_ms=0, filtered from
  // aggregation) doesn't bump the count and create an invisible slice.
  function onCategoryClick(key: string) {
    const cat = key as TopicCategory;
    const projects = new Set<string>();
    for (const c of chunks) {
      if (c.category !== cat) continue;
      if (effectiveMs(c) <= 0) continue;
      // Project counts only when it's a real, non-catch-all slug. The
      // 'personal' / 'misc' slug is the wildcard bucket and should NOT
      // count toward "this category has projects worth drilling into."
      // (Becomes dead code once the personal→null migration lands; the
      // tree-model invariant means non-work chunks have project=null.)
      if (c.project && c.project !== 'personal' && c.project !== 'misc') {
        projects.add(c.project);
      }
    }
    if (projects.size === 0) {
      setState({ level: 'L2C', category: cat });
    } else {
      setState({ level: 'L1', category: cat });
    }
  }

  function onDrillSliceClick(key: string) {
    if (state.level === 'L1') {
      setState({ level: 'L2P', category: state.category, project: key });
    }
    // L2P / L2C: titles, no further drill.
  }

  function popTo(target: 'L0' | 'L1') {
    if (target === 'L0') setState({ level: 'L0' });
    else if (state.level === 'L2P') setState({ level: 'L1', category: state.category });
  }

  if (chunks.length === 0 || categoryAgg.totalMs === 0) {
    return <div className="mt-5 text-sm text-ink-subtle">No activity recorded.</div>;
  }

  return (
    <div className="mt-5">
      {/* Top row: Category + Device, side-by-side, equal weight. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
        <DonutPanel
          title="By category"
          slices={categoryAgg.slices}
          totalMs={categoryAgg.totalMs}
          size={120}
          activeKey={state.level !== 'L0' ? state.category : undefined}
          onSliceClick={onCategoryClick}
          drillable
        />
        <DonutPanel
          title="By device"
          slices={deviceAgg.slices}
          totalMs={deviceAgg.totalMs}
          size={120}
        />
      </div>

      {/* Drill panel — appears below on category click. */}
      {state.level !== 'L0' && drill && drill.totalMs > 0 && (
        <div className="mt-6 pt-5 border-t border-line">
          <Breadcrumb state={state} onPopTo={popTo} projects={projects} />
          <div className="mt-3">
            <DonutPanel
              title={undefined}
              slices={drill.slices}
              totalMs={drill.totalMs}
              size={140}
              activeKey={state.level === 'L2P' ? state.project : undefined}
              onSliceClick={
                state.level === 'L1' ? onDrillSliceClick : undefined
              }
              drillable={state.level === 'L1'}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Breadcrumb({
  state,
  onPopTo,
  projects,
}: {
  state: DrillState;
  onPopTo: (target: 'L0' | 'L1') => void;
  projects: ProjectsLookup;
}) {
  if (state.level === 'L0') return null;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={() => onPopTo('L0')}
        className="text-ink-muted hover:text-ink underline-offset-2 hover:underline"
      >
        All
      </button>
      <span className="text-ink-subtle">›</span>
      {state.level === 'L2P' ? (
        <>
          <button
            type="button"
            onClick={() => onPopTo('L1')}
            className="text-ink-muted hover:text-ink underline-offset-2 hover:underline"
          >
            {CATEGORY_LABEL[state.category]}
          </button>
          <span className="text-ink-subtle">›</span>
          <span className="text-ink font-semibold">
            {projects.byName(state.project)}
          </span>
        </>
      ) : (
        // L1 OR L2C — both render category as the leaf segment. L2C
        // intentionally hides the auto-skipped project so the user
        // doesn't see a phantom "Play › misc" step.
        <span className="text-ink font-semibold">{CATEGORY_LABEL[state.category]}</span>
      )}
      <button
        type="button"
        onClick={() => onPopTo('L0')}
        className="ml-2 text-ink-subtle hover:text-ink"
        aria-label="Clear drill"
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------
// Donut panel — donut + legend in one cell
// ---------------------------------------------------------------------

function DonutPanel({
  title,
  slices,
  totalMs,
  size,
  activeKey,
  onSliceClick,
  drillable = false,
}: {
  // Optional uppercase section label above the donut. Omit for the
  // drill panel where the breadcrumb already labels the section.
  title?: string;
  slices: Slice[];
  totalMs: number;
  size: number;
  activeKey?: string;
  onSliceClick?: (key: string) => void;
  drillable?: boolean;
}) {
  return (
    <div className="min-w-0">
      {title && (
        <div className="text-xs text-ink-subtle uppercase tracking-wider font-semibold mb-2">
          {title}
        </div>
      )}
      <div className="flex items-center gap-5 flex-wrap">
        <DonutChart
          slices={slices}
          totalMs={totalMs}
          size={size}
          activeKey={activeKey}
          onSliceClick={onSliceClick}
        />
        <Legend
          slices={slices}
          totalMs={totalMs}
          activeKey={activeKey}
          drillable={drillable && !!onSliceClick}
          onRowClick={onSliceClick}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Donut — path-based arc slices, individually clickable.
// ---------------------------------------------------------------------

function DonutChart({
  slices,
  totalMs,
  size,
  activeKey,
  onSliceClick,
}: {
  slices: Slice[];
  totalMs: number;
  size: number;
  activeKey?: string;
  onSliceClick?: (key: string) => void;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const padding = 4;
  const outerR = size / 2 - padding;
  // ~38% donut thickness. Visually chunky without crowding the center
  // text.
  const innerR = outerR * 0.62;

  // Reserve a small visual gap between adjacent slices. With a single
  // 100% slice we render a full ring instead — arc paths don't draw
  // at startAngle === endAngle.
  const minGapDeg = slices.length > 1 ? 1.5 : 0;
  const sweepBudget = 360 - minGapDeg * slices.length;
  let cur = 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
    >
      {/* track */}
      <circle
        cx={cx}
        cy={cy}
        r={(outerR + innerR) / 2}
        fill="none"
        stroke="rgb(var(--c-line))"
        strokeWidth={outerR - innerR}
      />
      {slices.length === 1 ? (
        <circle
          cx={cx}
          cy={cy}
          r={(outerR + innerR) / 2}
          fill="none"
          stroke={slices[0].color}
          strokeWidth={outerR - innerR}
          onClick={
            onSliceClick ? () => onSliceClick(slices[0].key) : undefined
          }
          className={onSliceClick ? 'cursor-pointer' : undefined}
        >
          <title>{`${slices[0].label} · ${humanize(slices[0].ms)}`}</title>
        </circle>
      ) : (
        slices.map((s) => {
          const sweep = (s.ms / totalMs) * sweepBudget;
          const startA = cur;
          const endA = cur + sweep;
          cur = endA + minGapDeg;
          const dimmed = activeKey && activeKey !== s.key;
          return (
            <path
              key={s.key}
              d={arcPath(cx, cy, outerR, innerR, startA, endA)}
              fill={s.color}
              fillOpacity={dimmed ? 0.35 : 1}
              onClick={
                onSliceClick ? () => onSliceClick(s.key) : undefined
              }
              className={cn(
                'transition-opacity',
                onSliceClick && 'cursor-pointer',
              )}
            >
              <title>{`${s.label} · ${humanize(s.ms)}`}</title>
            </path>
          );
        })
      )}
      <text
        x={cx}
        y={cy - innerR * 0.05}
        textAnchor="middle"
        className="fill-ink"
        style={{ fontSize: innerR * 0.42, fontWeight: 600 }}
      >
        {humanize(totalMs)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------
// Legend — clickable rows when drillable
// ---------------------------------------------------------------------

function Legend({
  slices,
  totalMs,
  activeKey,
  drillable,
  onRowClick,
}: {
  slices: Slice[];
  totalMs: number;
  activeKey?: string;
  drillable: boolean;
  onRowClick?: (key: string) => void;
}) {
  const MAX_ROWS = 8;
  const visible = slices.slice(0, MAX_ROWS);
  const hidden = slices.slice(MAX_ROWS);
  const hiddenMs = hidden.reduce((s, x) => s + x.ms, 0);

  return (
    <ul
      className="text-sm flex-1 min-w-0 max-h-[260px] overflow-y-auto overflow-x-hidden"
    >
      {visible.map((s) => {
        const pct = Math.round((s.ms / totalMs) * 100);
        const dimmed = activeKey && activeKey !== s.key;
        return (
          <li
            key={s.key}
            className={cn(
              'grid items-center gap-x-3 py-1 -mx-2 px-2 rounded transition-opacity',
              drillable && 'cursor-pointer hover:bg-paper-hover',
              dimmed && 'opacity-50',
            )}
            style={{ gridTemplateColumns: 'auto minmax(0,1fr) auto auto' }}
            onClick={
              drillable && onRowClick ? () => onRowClick(s.key) : undefined
            }
          >
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{ background: s.color }}
            />
            <span className="text-ink truncate">{s.label}</span>
            <span className="text-ink-subtle tabular-nums text-xs justify-self-end">
              {humanize(s.ms)}
            </span>
            <span className="text-ink-subtle tabular-nums text-xs justify-self-end w-9 text-right">
              {pct}%
            </span>
          </li>
        );
      })}
      {hidden.length > 0 && (
        <li
          className="grid items-center gap-x-3 py-1 -mx-2 px-2 text-ink-subtle italic"
          style={{ gridTemplateColumns: 'auto 1fr auto auto' }}
          title={`Misc bucket: ${hidden.length} small slices clumped`}
        >
          <span />
          <span className="truncate">+{hidden.length} more</span>
          <span className="tabular-nums text-xs justify-self-end">
            {humanize(hiddenMs)}
          </span>
          <span className="tabular-nums text-xs justify-self-end w-9 text-right">
            {Math.round((hiddenMs / totalMs) * 100)}%
          </span>
        </li>
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------
// Header / Mono — unchanged
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
