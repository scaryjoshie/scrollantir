import { useEffect, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/PageHeader';
import DatePicker, { startOfLocalDay } from '@/components/DatePicker';
import EmptyState from '@/components/EmptyState';
import Timeline from '@/features/today/Timeline';
import MapPane from '@/features/today/MapPane';
import DetailPane from '@/features/today/DetailPane';
import type {
  Moment,
  PlaceVisit,
  TimelineEntry,
  TravelLeg,
} from '@/features/today/types';
import {
  TodayLookupsProvider,
  useBuildLookups,
} from '@/features/today/lookups';
import {
  fetchPlaceVisits,
  fetchSleepByWakeDates,
  fetchTravelLegs,
} from '@/lib/api';

// Fallback day boundary when no sleep row exists for the displayed
// day. Used pre-derive (fresh DB) and on days the deriver couldn't
// confidently detect sleep. Sleep takes priority when present.
const FALLBACK_DAY_BOUNDARY_HOUR = 4;

function fallbackDayStart(day: Date): Date {
  const d = new Date(day);
  d.setHours(FALLBACK_DAY_BOUNDARY_HOUR, 0, 0, 0);
  return d;
}

function defaultWindow(day: Date): { fromIso: string; toIso: string } {
  const from = fallbackDayStart(day);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function nextDayKey(dayKey: string): string {
  const d = parseISO(dayKey);
  d.setDate(d.getDate() + 1);
  return format(d, 'yyyy-MM-dd');
}

export default function TodayPage() {
  const [day, setDay] = useState<Date>(() => startOfLocalDay(new Date()));
  const dayKey = format(day, 'yyyy-MM-dd');
  const tomorrowKey = nextDayKey(dayKey);

  // Sleep drives the day boundary. We need today's wake (= day_start)
  // and tomorrow's wake (= day_end). The single query returns both
  // when both exist; either may be absent (fresh DB, low confidence,
  // user still asleep) → fall back to FALLBACK_DAY_BOUNDARY_HOUR.
  const sleepQ = useQuery({
    queryKey: ['sleep', dayKey, tomorrowKey],
    queryFn: () => fetchSleepByWakeDates([dayKey, tomorrowKey]),
  });

  const wakeBounds = useMemo(() => {
    const rows = sleepQ.data ?? [];
    const todayWake = rows.find((r) => r.data.wake_local_date === dayKey);
    const tomorrowWake = rows.find((r) => r.data.wake_local_date === tomorrowKey);
    const fallback = defaultWindow(day);
    return {
      fromIso: todayWake?.end_ts ?? fallback.fromIso,
      toIso: tomorrowWake?.end_ts ?? fallback.toIso,
      todayWake: todayWake ?? null,
    };
  }, [sleepQ.data, day, dayKey, tomorrowKey]);
  const { fromIso, toIso, todayWake } = wakeBounds;

  // Visits + legs queries depend on the resolved day window — keyed
  // on the actual ISO bounds so a sleep row arriving later (and
  // shifting the boundary) refetches correctly.
  const visitsQ = useQuery({
    queryKey: ['place_visits', fromIso, toIso],
    queryFn: () => fetchPlaceVisits(fromIso, toIso),
    enabled: !sleepQ.isLoading,
  });
  const legsQ = useQuery({
    queryKey: ['travel_legs', fromIso, toIso],
    queryFn: () => fetchTravelLegs(fromIso, toIso),
    enabled: !sleepQ.isLoading,
  });

  const wakeMoment: Moment | null = useMemo(() => {
    if (!todayWake) return null;
    const wakeIso = todayWake.end_ts;
    const localTime = todayWake.provenance.wake_local_time?.slice(0, 5) ?? '';
    return {
      kind: 'moment',
      id: `wake-${dayKey}`,
      ts: wakeIso,
      label: localTime ? `Woke up at ${localTime}` : 'Woke up',
      glyph: '☀️',
      source_hint: 'sleep/v1',
    };
  }, [todayWake, dayKey]);

  const entries: TimelineEntry[] = useMemo(() => {
    const visits = visitsQ.data ?? [];
    const legs = legsQ.data ?? [];
    const spans: Array<PlaceVisit | TravelLeg> = [...visits, ...legs];
    spans.sort((a, b) => (a.start_ts < b.start_ts ? -1 : 1));
    // Wake Moment leads the day-narrative when sleep was confidently
    // detected. Without it (fallback boundary), the timeline starts
    // with whichever span is first — same as before.
    return wakeMoment ? [wakeMoment, ...spans] : spans;
  }, [visitsQ.data, legsQ.data, wakeMoment]);

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
  const isLoading = sleepQ.isLoading || visitsQ.isLoading || legsQ.isLoading;
  const error = sleepQ.error || visitsQ.error || legsQ.error;

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
              body={`Day starts at wake (or ${FALLBACK_DAY_BOUNDARY_HOUR}:00 if sleep wasn't detected).
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
