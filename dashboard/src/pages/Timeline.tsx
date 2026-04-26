import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertCircle } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import DatePicker, { startOfLocalDay } from '@/components/DatePicker';
import ThreeLaneTimeline from '@/features/timeline/ThreeLaneTimeline';
import Legend from '@/features/timeline/Legend';
import CursorReadout from '@/features/timeline/CursorReadout';
import Inspector from '@/features/timeline/Inspector';
import { groupByDevice, blockAt } from '@/features/timeline/blockLookup';
import { fetchBlocks } from '@/lib/api';
import { hiddenSources, useSettings } from '@/lib/settings';
import type { Block } from '@/lib/types';

export default function TimelinePage() {
  const [day, setDay] = useState<Date>(() => startOfLocalDay(new Date()));
  const [settings] = useSettings();
  const hide = useMemo(() => hiddenSources(settings), [settings]);
  const [cursorTime, setCursorTime] = useState<Date | null>(null);
  const [selected, setSelected] = useState<Block | null>(null);

  const dayEnd = useMemo(
    () => new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    [day],
  );

  const fromIso = day.toISOString();
  const toIso = dayEnd.toISOString();

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['blocks', fromIso, toIso, hide.join(',')],
    queryFn: () => fetchBlocks(fromIso, toIso, hide),
    staleTime: 60_000,
  });

  const blocks = data?.blocks ?? [];
  const stats = data?.stats;

  const byDevice = useMemo(() => groupByDevice(blocks), [blocks]);

  const cursorReadout = useMemo(() => {
    if (!cursorTime) return { mac: null, phone: null };
    const t = cursorTime.getTime();
    return {
      mac: blockAt(byDevice.mac, t),
      phone: blockAt(byDevice.phone, t),
    };
  }, [cursorTime, byDevice]);

  const inspectorStats = useMemo(() => {
    if (!selected) return { deviceTotalMs: undefined, appTotalMs: undefined };
    let deviceTotal = 0;
    let appTotal = 0;
    const src = selected.device === 'mac' ? byDevice.mac : byDevice.phone;
    for (const b of src) {
      const dur = b.end_ms - b.start_ms;
      deviceTotal += dur;
      if (selected.app && b.app === selected.app) appTotal += dur;
    }
    return { deviceTotalMs: deviceTotal, appTotalMs: selected.app ? appTotal : undefined };
  }, [selected, byDevice]);

  const subtitle = useMemo(() => {
    const parts: string[] = [format(day, 'EEEE, MMM d, yyyy')];
    if (stats) {
      parts.push(`${stats.blocks} blocks · ${stats.events_kept} events`);
      if (stats.events_total !== stats.events_kept) {
        parts.push(`${stats.events_total - stats.events_kept} hidden`);
      }
    }
    if (isFetching) parts.push('refreshing…');
    return parts.join(' · ');
  }, [day, stats, isFetching]);

  const handleHover = useCallback((t: Date | null) => setCursorTime(t), []);
  const handleSelect = useCallback((b: Block | null) => setSelected(b), []);
  const handleClose = useCallback(() => setSelected(null), []);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Timeline"
        subtitle={subtitle}
        right={<DatePicker value={day} onChange={setDay} />}
      />

      <div className="flex-1 min-h-0 grid grid-rows-[1fr_auto] bg-paper">
        <div className="grid grid-cols-[1fr_auto] min-h-0">
          <div className="relative min-h-0">
            {error && (
              <div
                className="absolute inset-x-0 top-4 mx-auto max-w-md z-20
                           flex items-start gap-2 text-sm text-danger bg-danger-soft
                           border border-danger/20 rounded-card p-3 shadow-card"
              >
                <AlertCircle size={16} className="mt-0.5" />
                <div>
                  <div className="font-medium">Failed to load events</div>
                  <div className="text-xs opacity-80 mt-0.5 break-all">
                    {(error as Error).message}
                  </div>
                </div>
              </div>
            )}

            {isLoading && !data ? (
              <div className="p-10 text-sm text-ink-subtle">loading…</div>
            ) : (
              <ThreeLaneTimeline
                blocks={blocks}
                dayStart={day}
                dayEnd={dayEnd}
                showDetector={!settings.hideDetectorMiss}
                onHoverTime={handleHover}
                onSelectBlock={handleSelect}
                selectedBlockId={selected?.id ?? null}
              />
            )}
          </div>

          <Inspector
            block={selected}
            deviceTotalMs={inspectorStats.deviceTotalMs}
            appTotalMs={inspectorStats.appTotalMs}
            onClose={handleClose}
          />
        </div>

        <div className="border-t border-line px-10 py-3 flex items-center justify-between gap-6">
          <div className="min-w-0 flex-1">
            <CursorReadout
              time={cursorTime}
              macBlock={cursorReadout.mac}
              phoneBlock={cursorReadout.phone}
            />
          </div>
          <Legend />
        </div>
      </div>
    </div>
  );
}
