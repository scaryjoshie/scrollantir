import { useEffect, useRef } from 'react';
import { DataSet } from 'vis-data/esnext';
import {
  Timeline,
  type DataItem,
  type TimelineOptions,
} from 'vis-timeline/esnext';
import type { Block } from '@/lib/types';
import { colorForSource } from './colors';
import { buildGroups, sublaneFor } from './lanes';

type Props = {
  blocks: Block[];
  dayStart: Date;
  dayEnd: Date;
  showDetector: boolean;
  onHoverTime?: (time: Date | null) => void;
  onSelectBlock?: (block: Block | null) => void;
  selectedBlockId?: string | null;
};

export default function ThreeLaneTimeline({
  blocks,
  dayStart,
  dayEnd,
  showDetector,
  onHoverTime,
  onSelectBlock,
  selectedBlockId,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<Timeline | null>(null);
  const itemsRef = useRef<DataSet<DataItem> | null>(null);
  const groupsRef = useRef<DataSet<{
    id: string;
    content: string;
    nestedGroups?: string[];
    showNested?: boolean;
    order: number;
  }> | null>(null);
  const blockIndex = useRef(new Map<string, Block>());
  const hoverCbRef = useRef(onHoverTime);
  const selectCbRef = useRef(onSelectBlock);

  hoverCbRef.current = onHoverTime;
  selectCbRef.current = onSelectBlock;

  useEffect(() => {
    if (!containerRef.current) return;

    const items: DataSet<DataItem> = new DataSet<DataItem>([]);
    const groups = new DataSet(buildGroups({ showDetector }));
    itemsRef.current = items;
    groupsRef.current = groups;

    const options: TimelineOptions = {
      stack: false,
      stackSubgroups: false,
      start: dayStart,
      end: dayEnd,
      min: new Date(dayStart.getTime() - 24 * 3600 * 1000),
      max: new Date(dayEnd.getTime() + 24 * 3600 * 1000),
      zoomMin: 60 * 1000,
      zoomMax: 7 * 24 * 3600 * 1000,
      orientation: { axis: 'top' },
      margin: { item: { horizontal: 0, vertical: 3 }, axis: 8 },
      moveable: true,
      zoomable: true,
      selectable: true,
      multiselect: false,
      showCurrentTime: true,
      tooltip: { followMouse: true, overflowMethod: 'flip' },
      groupOrder: 'order',
      format: {
        minorLabels: {
          millisecond: 'SSS',
          second: 's',
          minute: 'HH:mm',
          hour: 'HH:mm',
          weekday: 'ddd D',
          day: 'D',
          month: 'MMM',
          year: 'YYYY',
        },
        majorLabels: {
          millisecond: 'HH:mm:ss',
          second: 'D MMM HH:mm',
          minute: 'ddd D MMM',
          hour: 'ddd D MMM',
          weekday: 'MMM YYYY',
          day: 'MMM YYYY',
          month: 'YYYY',
          year: '',
        },
      },
    };

    const tl = new Timeline(containerRef.current, items, groups, options);
    timelineRef.current = tl;

    const moveHandler = (props: { time: Date }) => {
      hoverCbRef.current?.(props.time);
    };
    const clickHandler = (props: { item?: string | number | null }) => {
      if (!props.item) {
        selectCbRef.current?.(null);
        return;
      }
      const b = blockIndex.current.get(String(props.item));
      selectCbRef.current?.(b ?? null);
    };
    tl.on('mouseMove', moveHandler);
    tl.on('click', clickHandler);

    const el = containerRef.current;
    const leaveHandler = () => hoverCbRef.current?.(null);
    el.addEventListener('mouseleave', leaveHandler);

    return () => {
      tl.off('mouseMove', moveHandler);
      tl.off('click', clickHandler);
      el.removeEventListener('mouseleave', leaveHandler);
      tl.destroy();
      timelineRef.current = null;
      itemsRef.current = null;
      groupsRef.current = null;
      blockIndex.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const groups = groupsRef.current;
    if (!groups) return;
    const next = buildGroups({ showDetector });
    groups.clear();
    groups.add(next);
  }, [showDetector]);

  useEffect(() => {
    const tl = timelineRef.current;
    if (!tl) return;
    tl.setWindow(dayStart, dayEnd, {
      animation: { duration: 200, easingFunction: 'easeOutQuad' },
    });
  }, [dayStart.getTime(), dayEnd.getTime()]);

  useEffect(() => {
    const items = itemsRef.current;
    if (!items) return;

    const idx = blockIndex.current;
    idx.clear();

    const data: DataItem[] = blocks.map((b) => {
      idx.set(b.id, b);
      const color = colorForSource(b.source);
      return {
        id: b.id,
        group: sublaneFor(b.device, b.source),
        start: new Date(b.start_ms),
        end: new Date(b.end_ms),
        content: escapeHtml(b.label),
        title: tooltipHtml(b),
        className: color.className,
        type: 'range' as const,
      };
    });

    items.clear();
    items.add(data);
  }, [blocks]);

  useEffect(() => {
    const tl = timelineRef.current;
    if (!tl) return;
    if (selectedBlockId) {
      tl.setSelection([selectedBlockId], { focus: false, animation: { animation: false } });
    } else {
      tl.setSelection([]);
    }
  }, [selectedBlockId]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function tooltipHtml(b: Block) {
  const durS = Math.round((b.end_ms - b.start_ms) / 1000);
  const lines: string[] = [
    `<b>${escapeHtml(b.source)}</b>`,
    `<span style="opacity:.75">${formatTime(b.start_ms)} → ${formatTime(b.end_ms)} · ${formatDur(durS)}</span>`,
  ];
  if (b.app) lines.push(`app: ${escapeHtml(b.app)}`);
  if (b.title && b.title !== b.app) lines.push(`title: ${escapeHtml(truncate(b.title, 90))}`);
  if (b.url) lines.push(`url: ${escapeHtml(truncate(b.url, 90))}`);
  if (b.merged > 1) lines.push(`<span style="opacity:.65">${b.merged} events merged</span>`);
  return lines.join('<br/>');
}

function formatTime(ms: number) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatDur(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
