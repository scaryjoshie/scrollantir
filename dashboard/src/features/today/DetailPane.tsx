// Detail pane (bottom-right). For a place_visit: donut chart of topic
// distribution + legend, plus a work/play/neutral spectrum bar at the
// bottom. Per-topic colors come from category-keyed palettes so the
// donut visually conveys both topic identity and category.

import { useEffect, useState } from 'react';
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

// Category-keyed palette. Each category gets a small set of distinct
// hues so adjacent same-category slices in the donut still read as
// separate while keeping the category visually obvious.
const CATEGORY_PALETTES: Record<TopicCategory, string[]> = {
  work: ['#5C8AD9', '#5CB1A0', '#7AB55C', '#5CB8C7'],
  play: ['#E07B5C', '#E07B98', '#D9A35C', '#B85CD9'],
  neutral: ['#8E8B85', '#A39E94', '#7A7570'],
};

function topicColor(topic: string, category: TopicCategory): string {
  let hash = 0;
  for (let i = 0; i < topic.length; i++) {
    hash = (hash * 31 + topic.charCodeAt(i)) | 0;
  }
  const palette = CATEGORY_PALETTES[category];
  return palette[Math.abs(hash) % palette.length];
}

const CATEGORY_BAR: Record<TopicCategory, string> = {
  work: '#5CB084',
  play: '#D9755C',
  neutral: '#A39E94',
};

function fmtTime(iso: string): string {
  return format(parseISO(iso), 'h:mm a');
}

function fmtDuration(startIso: string, endIso: string): string {
  return humanize(parseISO(endIso).getTime() - parseISO(startIso).getTime());
}

// Live `now` tick — the detail pane's open-visit subtitle counts up
// in 30s steps without needing a full data refetch.
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

type TopicAgg = { topic: string; category: TopicCategory; ms: number };

// Per-place-category synthetic baseline ratios. Stand-in until we have
// 14 days of history; the eventual real baseline is the user's median
// work/play split for visits to this place category over the window.
const BASELINE_RATIOS: Record<string, { work: number; neutral: number; play: number }> = {
  residence: { work: 0.45, neutral: 0.10, play: 0.45 },
  food:      { work: 0.30, neutral: 0.40, play: 0.30 },
  class:     { work: 0.95, neutral: 0.05, play: 0.00 },
  study:     { work: 0.85, neutral: 0.05, play: 0.10 },
  social:    { work: 0.05, neutral: 0.20, play: 0.75 },
  work:      { work: 0.90, neutral: 0.05, play: 0.05 },
  mixed:     { work: 0.60, neutral: 0.10, play: 0.30 },
};

function baselineFor(
  visit: PlaceVisit,
  totalMs: number,
): Record<TopicCategory, number> {
  const cat = visit.place?.category ?? 'mixed';
  const r = BASELINE_RATIOS[cat] ?? BASELINE_RATIOS.mixed;
  return {
    work: Math.round(totalMs * r.work),
    neutral: Math.round(totalMs * r.neutral),
    play: Math.round(totalMs * r.play),
  };
}

export default function DetailPane({ entry }: { entry: TimelineEntry | null }) {
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
  if (entry.kind === 'place_visit') return <VisitDetail visit={entry} />;
  if (entry.kind === 'travel_leg') return <LegDetail leg={entry} />;
  return <ChunkDetail chunk={entry} />;
}

// ---------------------------------------------------------------------
// Visit detail — donut + legend, then spectrum bar
// ---------------------------------------------------------------------

function VisitDetail({ visit }: { visit: PlaceVisit }) {
  const { topicChunks } = useTodayLookups();
  const now = useNowTick();
  const chunks = topicChunks
    .filter((c) => c.parent_id === visit.id)
    .sort((a, b) => (a.start_ts < b.start_ts ? -1 : 1));

  const byTopic = new Map<string, TopicAgg>();
  for (const c of chunks) {
    const existing = byTopic.get(c.topic);
    const ms = chunkMs(c);
    if (existing) existing.ms += ms;
    else byTopic.set(c.topic, { topic: c.topic, category: c.category, ms });
  }
  const topics = Array.from(byTopic.values()).sort((a, b) => b.ms - a.ms);

  const totals: Record<TopicCategory, number> = { work: 0, play: 0, neutral: 0 };
  for (const t of topics) totals[t.category] += t.ms;
  const totalMs = totals.work + totals.play + totals.neutral;

  // Open visits show "Since 3:25 PM · 2h 15m · ongoing" with the
  // duration counted live to `now`. Closed visits show the canonical
  // start–end range.
  const subtitle = visit.data.is_open
    ? `Since ${fmtTime(visit.start_ts)} · ${humanize(
        now - parseISO(visit.start_ts).getTime(),
      )} · ongoing`
    : `${fmtTime(visit.start_ts)} – ${fmtTime(visit.end_ts)} · ${fmtDuration(
        visit.start_ts,
        visit.end_ts,
      )}`;

  return (
    <div className="px-6 py-5">
      <Header
        title={visit.place?.name ?? 'Unknown place'}
        subtitle={subtitle}
        chip={visit.place?.category}
        live={visit.data.is_open}
      />

      {topics.length > 0 && totalMs > 0 ? (
        <div className="mt-5 flex items-center gap-7">
          <Donut topics={topics} totalMs={totalMs} size={148} />
          <Legend topics={topics} totalMs={totalMs} />
        </div>
      ) : (
        <div className="mt-4 text-sm text-ink-subtle">No activity recorded.</div>
      )}

      {totalMs > 0 && (
        <div className="mt-6">
          <SpectrumBar
            totals={totals}
            totalMs={totalMs}
            baseline={baselineFor(visit, totalMs)}
          />
        </div>
      )}
    </div>
  );
}

function LegDetail({ leg }: { leg: TravelLeg }) {
  const { visitById } = useTodayLookups();
  const from = visitById[leg.data.from_visit_id];
  const to = visitById[leg.data.to_visit_id];
  return (
    <div className="px-6 py-5">
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
    </div>
  );
}

function ChunkDetail({ chunk }: { chunk: TopicChunk }) {
  const { visitById, legById } = useTodayLookups();
  const parentVisit = visitById[chunk.parent_id];
  const parentLeg = parentVisit ? null : legById[chunk.parent_id];
  // Chip describes the surrounding context: place name for visit-children,
  // travel mode for leg-children (so a "Spotify" chunk under a bike leg
  // reads as "Spotify · Bike", not "Spotify · ?").
  let chip: string | undefined;
  if (parentVisit) chip = parentVisit.place?.name;
  else if (parentLeg) {
    chip = ACTIVITY_LABEL[parentLeg.data.dominant_activity];
  }
  const color = topicColor(chunk.topic, chunk.category);
  return (
    <div className="px-6 py-5">
      <Header
        title={chunk.topic}
        subtitle={`${fmtTime(chunk.start_ts)} – ${fmtTime(chunk.end_ts)} · ${fmtDuration(
          chunk.start_ts,
          chunk.end_ts,
        )}`}
        chip={chip}
        accent={color}
      />
      <div className="text-xs text-ink-subtle mt-3 flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: CATEGORY_BAR[chunk.category] }}
        />
        {CATEGORY_LABEL[chunk.category]}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Building blocks
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

// ---------------------------------------------------------------------
// Donut chart (SVG)
// ---------------------------------------------------------------------

function Donut({
  topics,
  totalMs,
  size,
}: {
  topics: TopicAgg[];
  totalMs: number;
  size: number;
}) {
  const cx = size / 2;
  const cy = size / 2;
  // Compute radius so that the stroked donut (radius ± strokeWidth/2)
  // stays inside the viewBox with a small visual padding. Fixed
  // strokeWidth keeps the donut chunky regardless of size.
  const strokeWidth = 24;
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
      {/* track */}
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="transparent"
        stroke="rgb(var(--c-line))"
        strokeWidth={strokeWidth}
      />
      {/* slices */}
      {topics.map((t) => {
        const fraction = t.ms / totalMs;
        const dashLength = circumference * fraction;
        const gap = Math.min(2, dashLength * 0.15);
        const slice = (
          <circle
            key={t.topic}
            cx={cx}
            cy={cy}
            r={radius}
            fill="transparent"
            stroke={topicColor(t.topic, t.category)}
            strokeWidth={strokeWidth}
            strokeDasharray={`${Math.max(0, dashLength - gap)} ${circumference}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        );
        offset += dashLength;
        return slice;
      })}
      {/* center label */}
      <text
        x={cx}
        y={cy - 2}
        textAnchor="middle"
        className="fill-ink"
        style={{ fontSize: innerRadius * 0.34, fontWeight: 600 }}
      >
        {humanize(totalMs)}
      </text>
      <text
        x={cx}
        y={cy + innerRadius * 0.36}
        textAnchor="middle"
        className="fill-ink-subtle"
        style={{ fontSize: innerRadius * 0.2 }}
      >
        total
      </text>
    </svg>
  );
}

function Legend({
  topics,
  totalMs,
}: {
  topics: TopicAgg[];
  totalMs: number;
}) {
  return (
    <ul
      className="grid items-center gap-x-3 gap-y-1.5 text-sm"
      style={{ gridTemplateColumns: 'auto auto auto auto' }}
    >
      {topics.map((t) => {
        const pct = Math.round((t.ms / totalMs) * 100);
        return (
          <li key={t.topic} className="contents">
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{ background: topicColor(t.topic, t.category) }}
            />
            <span className="text-ink whitespace-nowrap">{t.topic}</span>
            <span className="text-ink-subtle tabular-nums text-xs justify-self-end">
              {humanize(t.ms)}
            </span>
            <span className="text-ink-subtle tabular-nums text-xs justify-self-end w-8 text-right">
              {pct}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function SpectrumBar({
  totals,
  totalMs,
  baseline,
}: {
  totals: Record<TopicCategory, number>;
  totalMs: number;
  baseline?: Record<TopicCategory, number>;
}) {
  const baselineTotal = baseline
    ? baseline.work + baseline.neutral + baseline.play
    : 0;

  return (
    <div className="space-y-4">
      <SpectrumRow
        label="Today"
        totals={totals}
        totalMs={totalMs}
        muted={false}
      />
      {baseline && baselineTotal > 0 && (
        <SpectrumRow
          label="Typical"
          totals={baseline}
          totalMs={baselineTotal}
          muted
        />
      )}
    </div>
  );
}

function SpectrumRow({
  label,
  totals,
  totalMs,
  muted,
}: {
  label: string;
  totals: Record<TopicCategory, number>;
  totalMs: number;
  muted: boolean;
}) {
  const order: TopicCategory[] = ['work', 'neutral', 'play'];
  const segs = order
    .map((k) => ({ key: k, ms: totals[k] }))
    .filter((s) => s.ms > 0);

  return (
    <div>
      <div
        className={cn(
          'text-xs uppercase tracking-wider font-semibold mb-1.5',
          muted ? 'text-ink-subtle' : 'text-ink',
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          'flex rounded-full overflow-hidden',
          muted ? 'h-2 bg-paper-hover/60' : 'h-3.5 bg-paper-hover',
        )}
      >
        {segs.map((s) => (
          <div
            key={s.key}
            style={{
              width: `${(s.ms / totalMs) * 100}%`,
              background: CATEGORY_BAR[s.key],
              opacity: muted ? 0.45 : 1,
            }}
            title={`${CATEGORY_LABEL[s.key]} ${humanize(s.ms)}`}
          />
        ))}
      </div>
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums mt-2',
          muted ? 'text-ink-subtle' : 'text-ink-muted',
        )}
      >
        {order.map((k) =>
          totals[k] > 0 ? (
            <span key={k} className="flex items-center gap-1.5">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{
                  background: CATEGORY_BAR[k],
                  opacity: muted ? 0.5 : 1,
                }}
              />
              <span>
                {CATEGORY_LABEL[k]} {humanize(totals[k])}
              </span>
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
