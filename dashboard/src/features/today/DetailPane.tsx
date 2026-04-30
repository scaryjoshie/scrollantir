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

// Mac-precedence aggregation: phone time is only counted during
// minutes when no Mac chunk overlaps. Without this, watching YouTube
// on phone while working on Mac double-counts the same wall-clock
// time and the donut total exceeds the visit's wall-clock duration.
//
// Algorithm: build the merged Mac-coverage interval set; for each
// phone chunk, subtract the overlap with any Mac interval; aggregate
// per topic with the adjusted phone duration.
function aggregateWithMacPrecedence(
  chunks: TopicChunk[],
): { topics: TopicAgg[]; totalMs: number } {
  const macIntervals: Array<[number, number]> = chunks
    .filter((c) => c.device === 'mac')
    .map((c) => [parseISO(c.start_ts).getTime(), parseISO(c.end_ts).getTime()]);
  // Merge overlapping/adjacent Mac intervals (sorted by start).
  macIntervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of macIntervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  // For a phone chunk, return its duration MINUS any minutes
  // overlapping with the merged Mac coverage.
  function phoneEffectiveMs(c: TopicChunk): number {
    const cs = parseISO(c.start_ts).getTime();
    const ce = parseISO(c.end_ts).getTime();
    let effective = ce - cs;
    for (const [ms, me] of merged) {
      if (me <= cs || ms >= ce) continue; // no overlap
      effective -= Math.min(me, ce) - Math.max(ms, cs);
      if (effective <= 0) return 0;
    }
    return effective;
  }
  const byTopic = new Map<string, TopicAgg>();
  for (const c of chunks) {
    const ms = c.device === 'phone' ? phoneEffectiveMs(c) : chunkMs(c);
    if (ms <= 0) continue;
    const existing = byTopic.get(c.topic);
    if (existing) existing.ms += ms;
    else byTopic.set(c.topic, { topic: c.topic, category: c.category, ms });
  }
  const topics = Array.from(byTopic.values()).sort((a, b) => b.ms - a.ms);
  const totalMs = topics.reduce((s, t) => s + t.ms, 0);
  return { topics, totalMs };
}

export default function DetailPane({
  entry,
  dayStartIso,
}: {
  entry: TimelineEntry | null;
  // The displayed day's start (always local 00:00 in current
  // implementation). Visits whose true start_ts lies before this get
  // their "Since X" subtitle + live duration clipped to dayStartIso so
  // a still-open overnight stay reads as "Since 12:00 AM (continued) ·
  // 7h ongoing" rather than "Since 11:35 PM · 16h ongoing".
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
  if (entry.kind === 'place_visit')
    return <VisitDetail visit={entry} dayStartIso={dayStartIso} />;
  if (entry.kind === 'travel_leg') return <LegDetail leg={entry} />;
  return <ChunkDetail chunk={entry} />;
}

// ---------------------------------------------------------------------
// Visit detail — donut + legend, then spectrum bar
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
  const chunks = topicChunks
    .filter((c) => c.parent_id === visit.id)
    .sort((a, b) => (a.start_ts < b.start_ts ? -1 : 1));

  const { topics, totalMs } = aggregateWithMacPrecedence(chunks);

  // For an open overnight visit (started before today's day boundary),
  // clip the displayed start to dayStartIso. Otherwise a Willard stay
  // that began 23:35 last night reads as "Since 11:35 PM · 16h ongoing"
  // — confusing — instead of "Since 12:00 AM (continued) · 7h ongoing".
  // Mirrors the Timeline (commit 159db7b) clipping logic.
  const startedBeforeToday =
    !!dayStartIso && visit.start_ts < dayStartIso;
  const displayStart = startedBeforeToday ? dayStartIso! : visit.start_ts;

  // Open visits show "Since 3:25 PM · 2h 15m · ongoing" with the
  // duration counted live to `now`. Closed visits show the canonical
  // start–end range.
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
    </div>
  );
}

function LegDetail({ leg }: { leg: TravelLeg }) {
  const { visitById, topicChunks } = useTodayLookups();
  const from = visitById[leg.data.from_visit_id];
  const to = visitById[leg.data.to_visit_id];
  // Chunks parented to this leg — "what apps/projects were active
  // while travelling." Walking with Spotify and a podcast still
  // accumulates time on those projects, just like working at a desk.
  const chunks = topicChunks
    .filter((c) => c.parent_id === leg.id)
    .sort((a, b) => (a.start_ts < b.start_ts ? -1 : 1));
  const { topics, totalMs } = aggregateWithMacPrecedence(chunks);
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
      {topics.length > 0 && totalMs > 0 && (
        <div className="mt-5 flex items-center gap-7">
          <Donut topics={topics} totalMs={totalMs} size={148} />
          <Legend topics={topics} totalMs={totalMs} />
        </div>
      )}
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

