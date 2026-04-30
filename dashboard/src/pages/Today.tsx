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
    // Day boundary uses kind='night' rows ONLY. kind='nap' rows can
    // also have a wake_local_date matching the displayed day, but
    // they're not the day's "real" wake — they're afternoon naps
    // and shouldn't shift /today's start.
    const todayNight = rows.find(
      (r) => r.data.wake_local_date === dayKey && r.data.kind === 'night',
    );
    const tomorrowNight = rows.find(
      (r) => r.data.wake_local_date === tomorrowKey && r.data.kind === 'night',
    );
    const todayNaps = rows.filter(
      (r) => r.data.wake_local_date === dayKey && r.data.kind === 'nap',
    );
    const fallback = defaultWindow(day);
    return {
      fromIso: todayNight?.end_ts ?? fallback.fromIso,
      toIso: tomorrowNight?.end_ts ?? fallback.toIso,
      todayNight: todayNight ?? null,
      todayNaps,
    };
  }, [sleepQ.data, day, dayKey, tomorrowKey]);
  const { fromIso, toIso, todayNight, todayNaps } = wakeBounds;

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
    if (!todayNight) return null;
    const localTime = todayNight.provenance.wake_local_time?.slice(0, 5) ?? '';
    return {
      kind: 'moment',
      id: `wake-${dayKey}`,
      ts: todayNight.end_ts,
      label: localTime ? `Woke up at ${localTime}` : 'Woke up',
      glyph: '☀️',
      source_hint: 'sleep/v1',
    };
  }, [todayNight, dayKey]);

  // Naps render as separate Moments inside the day. Each nap's
  // wake_ts is the Moment's anchor; the user can click to inspect.
  const napMoments: Moment[] = useMemo(() => {
    return todayNaps.map((nap) => {
      const localTime = nap.provenance.wake_local_time?.slice(0, 5) ?? '';
      const dur = Math.round(nap.provenance.duration_minutes);
      return {
        kind: 'moment',
        id: `nap-${dayKey}-${nap.provenance.rank}`,
        ts: nap.end_ts,
        label: localTime ? `Napped ${dur}m, woke at ${localTime}` : 'Nap',
        glyph: '😴',
        source_hint: 'sleep/v1',
      };
    });
  }, [todayNaps, dayKey]);

  const entries: TimelineEntry[] = useMemo(() => {
    const visits = visitsQ.data ?? [];
    const legs = legsQ.data ?? [];
    const spans: Array<PlaceVisit | TravelLeg> = [...visits, ...legs];
    const all: TimelineEntry[] = [
      ...(wakeMoment ? [wakeMoment] : []),
      ...spans,
      ...napMoments,
    ];
    // Sort by ts (Moments) or start_ts (spans) so naps slot in
    // chronologically with visits/legs.
    all.sort((a, b) => {
      const ta = a.kind === 'moment' ? a.ts : a.start_ts;
      const tb = b.kind === 'moment' ? b.ts : b.start_ts;
      return ta < tb ? -1 : 1;
    });
    return all;
  }, [visitsQ.data, legsQ.data, wakeMoment, napMoments]);

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
