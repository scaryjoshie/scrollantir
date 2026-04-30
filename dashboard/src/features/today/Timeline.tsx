// Vertical narrative timeline. Outer rows = moments / place_visits /
// travel_legs, alternating chronologically. Inner clusters render
// inline under their parent visit.
//
// One click → setSelected(id). The host page handles the rest (map
// camera, detail panel).

import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { cn } from '@/lib/cn';
import type { TimelineEntry, TopicCategory } from './types';

const CATEGORY_GLYPH: Record<string, string> = {
  residence: '🏠',
  class: '🎓',
  food: '🍔',
  study: '📚',
  social: '👯',
  work: '💼',
  mixed: '📍',
};

const ACTIVITY_GLYPH: Record<string, string> = {
  walking: '🚶',
  on_bicycle: '🚲',
  in_vehicle: '🚗',
  running: '🏃',
  still: '🧍',
};

const ACTIVITY_VERB: Record<string, string> = {
  walking: 'Walked',
  on_bicycle: 'Biked',
  in_vehicle: 'Drove',
  running: 'Ran',
  still: 'Stayed',
};

const CATEGORY_DOT: Record<TopicCategory, string> = {
  work: 'bg-success',
  play: 'bg-danger',
  neutral: 'bg-ink-subtle',
};

function fmtTime(iso: string): string {
  // Compact: 'h a' on round hours ("8 PM"), 'h:mm a' otherwise.
  const d = parseISO(iso);
  return format(d, d.getMinutes() === 0 ? 'h a' : 'h:mm a');
}

function fmtDuration(startIso: string, endIso: string): string {
  const ms = parseISO(endIso).getTime() - parseISO(startIso).getTime();
  return humanize(ms);
}

// Live duration from `startIso` to `now` — used for in-progress visits
// where the visible duration should tick up as the user keeps sitting
// there. The `now` tick (default 30s) re-renders only the rows that
// read it, so the cost is one timer per page.
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

export default function Timeline({
  entries,
  selectedId,
  onSelect,
  dayStartIso,
}: {
  entries: TimelineEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  // The day's start (= wake_ts when sleep was detected, otherwise
  // the fallback boundary). Spans whose true start_ts is before this
  // get rendered with their start clipped to dayStartIso, plus a
  // "(continued)" hint, so the day-narrative reads cleanly.
  dayStartIso: string;
}) {
  return (
    <div className="py-3">
      <ol className="relative">
        {entries.map((e) => (
          <Row
            key={e.id}
            entry={e}
            isSelected={e.id === selectedId}
            onSelect={onSelect}
            dayStartIso={dayStartIso}
          />
        ))}
      </ol>
    </div>
  );
}

function Row({
  entry,
  isSelected,
  onSelect,
  dayStartIso,
}: {
  entry: TimelineEntry;
  isSelected: boolean;
  onSelect: (id: string) => void;
  dayStartIso: string;
}) {
  if (entry.kind === 'topic_chunk') {
    return (
      <li className="relative ml-6 border-l border-line">
        <button
          type="button"
          onClick={() => onSelect(entry.id)}
          className={cn(
            'group w-full text-left pl-6 pr-4 py-1.5',
            'hover:bg-paper-hover transition-colors',
            isSelected && 'bg-accent-soft hover:bg-accent-soft',
          )}
        >
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'inline-block w-1.5 h-1.5 rounded-full shrink-0',
                CATEGORY_DOT[entry.category],
              )}
            />
            <span
              className={cn(
                'text-sm truncate',
                isSelected ? 'text-accent font-medium' : 'text-ink-muted',
              )}
            >
              {entry.topic}
            </span>
            <span className="text-xs text-ink-subtle ml-auto shrink-0 tabular-nums">
              {fmtTime(entry.start_ts)} · {fmtDuration(entry.start_ts, entry.end_ts)}
            </span>
          </div>
        </button>
      </li>
    );
  }

  // `now` ticks every 30s so an in-progress visit's live duration
  // updates without a full refetch. Cheap: one timer per timeline.
  const now = useNowTick();
  const isOpenVisit = entry.kind === 'place_visit' && entry.data.is_open;

  // Outer row: glyph | (title + duration on top row, time range below)
  let glyph: string;
  let title: string;
  let timeRange: string;
  let duration: string;
  if (entry.kind === 'moment') {
    glyph = entry.glyph;
    title = entry.label;
    timeRange = fmtTime(entry.ts);
    duration = '';
  } else if (entry.kind === 'place_visit') {
    glyph = CATEGORY_GLYPH[entry.place?.category ?? 'mixed'] ?? '📍';
    title = entry.place?.name ?? 'Unknown place';
    // Visit started before today's day boundary (e.g. overnight stay
    // that began 23:35 yesterday). Display clips to dayStartIso so
    // the timeline reads as the user's lived day, not the raw
    // start_ts. Duration ALSO clips so a 16h cross-day visit
    // doesn't dominate the rendered range.
    const startedBeforeToday = entry.start_ts < dayStartIso;
    const displayStart = startedBeforeToday ? dayStartIso : entry.start_ts;
    if (entry.data.is_open) {
      // Live: "Since X" + count to now.
      timeRange = startedBeforeToday
        ? `Since ${fmtTime(displayStart)} (continued)`
        : `Since ${fmtTime(entry.start_ts)}`;
      duration = humanize(now - parseISO(displayStart).getTime());
    } else if (startedBeforeToday) {
      timeRange = `${fmtTime(displayStart)} – ${fmtTime(entry.end_ts)} (continued)`;
      duration = fmtDuration(displayStart, entry.end_ts);
    } else {
      timeRange = `${fmtTime(entry.start_ts)} – ${fmtTime(entry.end_ts)}`;
      duration = fmtDuration(entry.start_ts, entry.end_ts);
    }
  } else {
    // travel_leg
    glyph = ACTIVITY_GLYPH[entry.data.dominant_activity] ?? '🚶';
    const verb = ACTIVITY_VERB[entry.data.dominant_activity] ?? 'Travelled';
    const meters = Math.round(entry.data.distance_m);
    title = `${verb} ${meters < 1000 ? `${meters} m` : `${(meters / 1000).toFixed(1)} km`}`;
    timeRange = `${fmtTime(entry.start_ts)} – ${fmtTime(entry.end_ts)}`;
    duration = fmtDuration(entry.start_ts, entry.end_ts);
  }

  return (
    <li className="relative">
      <button
        type="button"
        onClick={() => onSelect(entry.id)}
        className={cn(
          'group w-full text-left pl-4 pr-4 py-2.5',
          'flex items-start gap-3',
          'hover:bg-paper-hover transition-colors',
          isSelected && 'bg-accent-soft hover:bg-accent-soft',
        )}
      >
        <span
          className={cn(
            'relative shrink-0 w-8 h-8 rounded-full grid place-items-center text-base',
            'bg-paper border border-line',
            isSelected && 'border-accent',
          )}
        >
          {glyph}
          {/* Live dot for an in-progress visit. Sits on the glyph's
              top-right corner; pulses to read as "ongoing" rather
              than "ended". */}
          {isOpenVisit && (
            <span
              className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full
                         bg-success ring-2 ring-paper-panel
                         animate-pulse"
              aria-label="Currently here"
              title="Currently here"
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                'text-sm font-medium truncate',
                isSelected ? 'text-accent' : 'text-ink',
              )}
            >
              {title}
            </span>
            {duration && (
              <span
                className={cn(
                  'ml-auto shrink-0 text-xs tabular-nums',
                  isOpenVisit ? 'text-success font-medium' : 'text-ink-subtle',
                )}
              >
                {duration}
              </span>
            )}
          </span>
          <span className="block text-xs text-ink-subtle truncate mt-0.5 tabular-nums">
            {timeRange}
          </span>
        </span>
      </button>
    </li>
  );
}
