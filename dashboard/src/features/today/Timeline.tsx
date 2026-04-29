// Vertical narrative timeline. Outer rows = moments / place_visits /
// travel_legs, alternating chronologically. Inner clusters render
// inline under their parent visit.
//
// One click → setSelected(id). The host page handles the rest (map
// camera, detail panel).

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
}: {
  entries: TimelineEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
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
}: {
  entry: TimelineEntry;
  isSelected: boolean;
  onSelect: (id: string) => void;
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
    timeRange = `${fmtTime(entry.start_ts)} – ${fmtTime(entry.end_ts)}`;
    duration = fmtDuration(entry.start_ts, entry.end_ts);
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
            'shrink-0 w-8 h-8 rounded-full grid place-items-center text-base',
            'bg-paper border border-line',
            isSelected && 'border-accent',
          )}
        >
          {glyph}
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
              <span className="ml-auto shrink-0 text-xs text-ink-subtle tabular-nums">
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
