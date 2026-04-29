import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/PageHeader';
import DatePicker, { startOfLocalDay } from '@/components/DatePicker';
import EmptyState from '@/components/EmptyState';
import Timeline from '@/features/today/Timeline';
import MapPane from '@/features/today/MapPane';
import DetailPane from '@/features/today/DetailPane';
import type { PlaceVisit, TimelineEntry, TravelLeg } from '@/features/today/types';
import {
  TodayLookupsProvider,
  useBuildLookups,
} from '@/features/today/lookups';
import { fetchPlaceVisits, fetchTravelLegs } from '@/lib/api';

// Day boundary 04:00 → 04:00 next morning. Late-night activity past
// midnight but before bed belongs to the previous calendar date's
// view. Matches the deriver's window-keying convention.
const DAY_BOUNDARY_HOUR = 4;

function dayWindow(day: Date): { fromIso: string; toIso: string } {
  const from = new Date(day);
  from.setHours(DAY_BOUNDARY_HOUR, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

export default function TodayPage() {
  const [day, setDay] = useState<Date>(() => startOfLocalDay(new Date()));
  const { fromIso, toIso } = dayWindow(day);
  const dayKey = format(day, 'yyyy-MM-dd');

  const visitsQ = useQuery({
    queryKey: ['place_visits', dayKey],
    queryFn: () => fetchPlaceVisits(fromIso, toIso),
  });
  const legsQ = useQuery({
    queryKey: ['travel_legs', dayKey],
    queryFn: () => fetchTravelLegs(fromIso, toIso),
  });

  const entries: TimelineEntry[] = useMemo(() => {
    const visits = visitsQ.data ?? [];
    const legs = legsQ.data ?? [];
    // Visits + legs both have start_ts (Moment uses `ts` and isn't
    // fetched in v0). Sort by start_ts then re-widen to TimelineEntry
    // for the consumer panes.
    const merged: Array<PlaceVisit | TravelLeg> = [...visits, ...legs];
    merged.sort((a, b) => (a.start_ts < b.start_ts ? -1 : 1));
    return merged;
  }, [visitsQ.data, legsQ.data]);

  const lookups = useBuildLookups(visitsQ.data, legsQ.data);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reset selection on day change.
  useEffect(() => {
    setSelectedId(entries[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);

  // If the selected id isn't in the current entries (post-fetch), reset.
  useEffect(() => {
    if (selectedId && !entries.some((e) => e.id === selectedId)) {
      setSelectedId(entries[0]?.id ?? null);
    }
  }, [entries, selectedId]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const subtitle = format(day, 'EEEE');
  const isLoading = visitsQ.isLoading || legsQ.isLoading;
  const error = visitsQ.error || legsQ.error;

  return (
    <TodayLookupsProvider value={lookups}>
    <div className="flex flex-col h-full">
      <PageHeader
        title="Today"
        subtitle={subtitle}
        right={<DatePicker value={day} onChange={setDay} />}
      />

      <div className="grid grid-cols-[400px_1fr] min-h-0 flex-1">
        <aside className="border-r border-line bg-paper-panel overflow-y-auto">
          {isLoading ? (
            <EmptyState title="Loading…" body="Fetching the day's events." />
          ) : error ? (
            <EmptyState
              title="Couldn't load"
              body={error instanceof Error ? error.message : String(error)}
            />
          ) : entries.length === 0 ? (
            <EmptyState
              title="No data for this day"
              body={`Day boundary runs ${DAY_BOUNDARY_HOUR}:00 → ${DAY_BOUNDARY_HOUR}:00.
Pick a different day, or wait for the deriver to run.`}
            />
          ) : (
            <Timeline
              entries={entries}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </aside>

        <div className="grid grid-rows-[1fr_1fr] min-h-0">
          <div className="relative border-b border-line bg-paper-soft min-h-0">
            <MapPane selected={selected} />
          </div>
          <div className="bg-paper-panel min-h-0 overflow-y-auto">
            <DetailPane entry={selected} />
          </div>
        </div>
      </div>
    </div>
    </TodayLookupsProvider>
  );
}
