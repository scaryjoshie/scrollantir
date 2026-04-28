import { useEffect, useRef } from 'react';
import { Timeline, DataSet } from 'vis-timeline/standalone';
import 'vis-timeline/styles/vis-timeline-graph2d.min.css';
import type { DashboardEvent } from '@/lib/types';

type Props = {
  events: DashboardEvent[];
  fromIso: string;
  toIso: string;
  onSelect: (event: DashboardEvent | null) => void;
};

// Point events (start_ts == end_ts, e.g. detector.miss) get a tiny
// visible width so they're clickable. 1s is enough at sub-day zoom.
const POINT_PAD_MS = 1000;

export default function RawTimeline({ events, fromIso, toIso, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<Timeline | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Build groups (one swim lane per distinct source, sorted alphabetically
    // so mac.* and phone.* group naturally).
    const groupIds = [...new Set(events.map((e) => e.source))].sort();
    const groups = new DataSet(
      groupIds.map((id) => ({ id, content: id, className: 'raw-group' })),
    );

    // Build items.
    const items = new DataSet(
      events.map((e) => {
        const startMs = Date.parse(e.start_ts);
        const endMs = Date.parse(e.end_ts);
        const isPoint = endMs <= startMs;
        return {
          id: e.id,
          group: e.source,
          start: startMs,
          end: isPoint ? startMs + POINT_PAD_MS : endMs,
          type: isPoint ? 'point' : 'range',
          title: `${e.source}\n${e.start_ts}\nduration: ${e.duration_s.toFixed(1)}s`,
          content: '',
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
  }, [events, fromIso, toIso, onSelect]);

  return <div ref={containerRef} className="w-full h-full" />;
}
