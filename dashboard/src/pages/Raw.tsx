import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { startOfDay, endOfDay } from 'date-fns';
import PageHeader from '@/components/PageHeader';
import DatePicker from '@/components/DatePicker';
import EmptyState from '@/components/EmptyState';
import RawTimeline from '@/features/raw/RawTimeline';
import RawInspector from '@/features/raw/RawInspector';
import DeviceLastSeenBadges from '@/features/raw/DeviceLastSeenBadges';
import { fetchEvents } from '@/lib/api';
import type { DashboardEvent } from '@/lib/types';

export default function RawPage() {
  const [day, setDay] = useState(() => new Date());
  const [selected, setSelected] = useState<DashboardEvent | null>(null);

  const fromIso = useMemo(() => startOfDay(day).toISOString(), [day]);
  const toIso = useMemo(() => endOfDay(day).toISOString(), [day]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['events', fromIso, toIso],
    queryFn: () => fetchEvents(fromIso, toIso),
  });

  const events = data ?? [];
  const sourceCount = new Set(events.map((e) => e.source)).size;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Raw"
        subtitle={
          isLoading
            ? 'Loading…'
            : error
              ? 'Error'
              : `${events.length} events across ${sourceCount} sources — one swim lane per source`
        }
        right={
          <div className="flex items-center gap-3">
            <DeviceLastSeenBadges />
            <DatePicker value={day} onChange={setDay} />
          </div>
        }
      />

      <div className="grid grid-cols-[1fr_360px] min-h-0 flex-1">
        <div className="overflow-hidden bg-paper">
          {error ? (
            <div className="p-6 text-sm text-danger break-all">
              <div className="font-medium mb-1">Failed to load events</div>
              {(error as Error).message}
            </div>
          ) : !isLoading && events.length === 0 ? (
            <EmptyState
              title="No events in this window"
              body="Try a different day, or check that devices are still posting."
            />
          ) : (
            <RawTimeline
              events={events}
              fromIso={fromIso}
              toIso={toIso}
              onSelect={setSelected}
            />
          )}
        </div>
        <aside className="border-l border-line bg-paper-panel overflow-y-auto">
          <RawInspector event={selected} />
        </aside>
      </div>
    </div>
  );
}
