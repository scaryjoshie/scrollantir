import { useEffect, useMemo, useRef } from 'react';
import { Timeline, DataSet } from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.min.css';
import type { DashboardEvent } from '@/lib/types';

type Props = {
  events: DashboardEvent[];
  fromIso: string;
  toIso: string;
  onSelect: (event: DashboardEvent | null) => void;
};

// Stable-per-source HSL color from a hash of the source string.
function hueFor(source: string): number {
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

function fillFor(source: string): string {
  return `hsl(${hueFor(source)}, 70%, 62%)`;
}

function borderFor(source: string): string {
  return `hsl(${hueFor(source)}, 60%, 40%)`;
}

// What text should appear inside a duration block? Source-specific —
// pulls the most useful field from `data` for each known source.
function inlineLabel(e: DashboardEvent): string {
  const d = e.data ?? {};
  switch (e.source) {
    case 'mac.system.window':
      return String(d.app ?? '');
    case 'mac.zen.tab':
      return String(d.title ?? d.url ?? '').slice(0, 80);
    case 'mac.system.afk':
      return String(d.status ?? '');
    case 'phone.system.foreground':
      return String(d.app_label ?? d.app ?? '');
    case 'phone.system.screen':
      return String(d.state ?? '');
    default:
      return '';
  }
}

function fmtDur(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  if (seconds >= 1) return `${Math.round(seconds)}s`;
  return seconds === 0 ? '·' : `${seconds.toFixed(2)}s`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default function RawTimeline({
  events,
  fromIso,
  toIso,
  onSelect,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<Timeline | null>(null);

  // Per-source totals for the group label (count · total duration).
  const stats = useMemo(() => {
    const m = new Map<string, { count: number; totalSec: number }>();
    for (const e of events) {
      const s = m.get(e.source) ?? { count: 0, totalSec: 0 };
      s.count++;
      s.totalSec += e.duration_s;
      m.set(e.source, s);
    }
    return m;
  }, [events]);

  useEffect(() => {
    if (!containerRef.current) return;

    const groupIds = [...stats.keys()].sort();
    const groups = new DataSet(
      groupIds.map((id) => {
        const s = stats.get(id)!;
        const hue = hueFor(id);
        const safeId = escapeHtml(id);
        return {
          id,
          content: `
            <div class="raw-group-label">
              <span class="raw-group-swatch" style="background:hsl(${hue},70%,62%)"></span>
              <div class="raw-group-text">
                <div class="raw-group-source">${safeId}</div>
                <div class="raw-group-stats">${s.count} · ${fmtDur(s.totalSec)}</div>
              </div>
            </div>`,
        };
      }),
    );

    const items = new DataSet(
      events.map((e) => {
        const startMs = Date.parse(e.start_ts);
        const endMs = Date.parse(e.end_ts);
        const isPoint = endMs <= startMs;
        const label = inlineLabel(e);
        const fill = fillFor(e.source);
        const border = borderFor(e.source);
        return {
          id: e.id,
          group: e.source,
          start: startMs,
          end: isPoint ? undefined : endMs,
          type: isPoint ? 'point' : 'range',
          content: label ? escapeHtml(label) : '',
          title: `${e.source}\n${e.start_ts}\nduration: ${e.duration_s.toFixed(1)}s`,
          style: isPoint
            ? `background-color:${border}; border-color:${border};`
            : `background-color:${fill}; border-color:${border}; color:#0d0d0d;`,
        };
      }),
    );

    const timeline = new Timeline(containerRef.current, items, groups, {
      stack: false,
      orientation: { axis: 'top' },
      showCurrentTime: true,
      zoomMin: 1000,
      zoomMax: 1000 * 60 * 60 * 24 * 30,
      start: fromIso,
      end: toIso,
      groupOrder: 'id',
      margin: { item: 4, axis: 4 },
      verticalScroll: true,
      maxHeight: '100%',
      moveable: true,
      zoomable: true,
    });

    timeline.on('select', (props: { items: (string | number)[] }) => {
      const id = props.items[0];
      if (id == null) {
        onSelect(null);
        return;
      }
      const ev = events.find((e) => e.id === id);
      onSelect(ev ?? null);
    });

    timelineRef.current = timeline;
    return () => {
      timeline.destroy();
      timelineRef.current = null;
    };
  }, [events, fromIso, toIso, onSelect, stats]);

  return <div ref={containerRef} className="raw-timeline w-full h-full" />;
}
