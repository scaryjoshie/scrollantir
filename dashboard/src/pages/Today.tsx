import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
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
  fetchProjectChunks,
  fetchSleepByWakeDates,
  fetchTravelLegs,
} from '@/lib/api';

// Day window is strictly local 00:00 → 24:00. Visits/legs that span
// midnight render on BOTH days, clipped to each day's window by the
// timeline's display logic. Sleep is shown as Moments (wake / nap)
// inside the day but does NOT shift the day boundary — the wake
// happens AT 8:26 AM, sized within an unchanging 00-24 frame.
function dayWindow(day: Date): { fromIso: string; toIso: string } {
  const from = new Date(day);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

export default function TodayPage() {
  const [day, setDay] = useState<Date>(() => startOfLocalDay(new Date()));
  const dayKey = format(day, 'yyyy-MM-dd');

  // Day window is fixed 00:00 → 24:00 local; doesn't depend on
  // sleep. Sleep rows still inform the wake/nap MOMENTS rendered
  // inside the day, but they don't shift the boundary.
  const { fromIso, toIso } = useMemo(() => dayWindow(day), [day]);

  const sleepQ = useQuery({
    queryKey: ['sleep', dayKey],
    queryFn: () => fetchSleepByWakeDates([dayKey]),
  });
  const todayNight = useMemo(
    () =>
      (sleepQ.data ?? []).find(
        (r) => r.data.wake_local_date === dayKey && r.data.kind === 'night',
      ) ?? null,
    [sleepQ.data, dayKey],
  );
  const todayNaps = useMemo(
    () =>
      (sleepQ.data ?? []).filter(
        (r) => r.data.wake_local_date === dayKey && r.data.kind === 'nap',
      ),
    [sleepQ.data, dayKey],
  );

  const visitsQ = useQuery({
    queryKey: ['place_visits', fromIso, toIso],
    queryFn: () => fetchPlaceVisits(fromIso, toIso),
  });
  const legsQ = useQuery({
    queryKey: ['travel_legs', fromIso, toIso],
    queryFn: () => fetchTravelLegs(fromIso, toIso),
  });
  const chunksQ = useQuery({
    queryKey: ['project_chunks', fromIso, toIso],
    queryFn: () => fetchProjectChunks(fromIso, toIso),
  });

  // Find the visit that CONTAINS a given timestamp — used to anchor
  // wake/nap Moments at the place the user was sleeping. Without
  // this, clicking a Moment leaves the map at its prior location
  // (or Chicago default) because Moments render with no coords.
  const findContainingVisit = (ts: string): PlaceVisit | undefined =>
    (visitsQ.data ?? []).find(
      (v) => v.start_ts <= ts && ts <= v.end_ts,
    );

  const wakeMoment: Moment | null = useMemo(() => {
    if (!todayNight) return null;
    const localTime = todayNight.provenance.wake_local_time?.slice(0, 5) ?? '';
    const containing = findContainingVisit(todayNight.end_ts);
    return {
      kind: 'moment',
      id: `wake-${dayKey}`,
      ts: todayNight.end_ts,
      label: localTime ? `Woke up at ${localTime}` : 'Woke up',
      glyph: '☀️',
      source_hint: 'sleep/v1',
      // Anchor at the place the user woke up — prefer the OSM POI
      // centroid (inside the building) for the highlight, falling
      // back to the visit's stay-centroid.
      lat: containing?.place?.centroid_lat ?? containing?.data.lat,
      lng: containing?.place?.centroid_lng ?? containing?.data.lng,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayNight, dayKey, visitsQ.data]);

  // Naps render as separate Moments inside the day. Each nap's
  // wake_ts is the Moment's anchor; the user can click to inspect.
  // Duration formatted as "Xh Ym" (matching the timeline's humanize
  // convention) — `${X}m` alone gets misread as "meters" because
  // travel legs use "m" for distance.
  const napMoments: Moment[] = useMemo(() => {
    return todayNaps.map((nap) => {
      const localTime = nap.provenance.wake_local_time?.slice(0, 5) ?? '';
      const totalMin = Math.round(nap.provenance.duration_minutes);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      const dur =
        h === 0 ? `${m} min` : m === 0 ? `${h}h` : `${h}h ${m}m`;
      // Anchor at the place the nap happened (place.centroid_lat/lng
      // when available, falling back to the stay-centroid). Without
      // this the map keeps the previous selection's coords on click.
      const containing = findContainingVisit(nap.end_ts);
      return {
        kind: 'moment',
        id: `nap-${dayKey}-${nap.provenance.rank}`,
        ts: nap.end_ts,
        label: localTime ? `Napped ${dur}, woke at ${localTime}` : 'Nap',
        glyph: '😴',
        source_hint: 'sleep/v1',
        lat: containing?.place?.centroid_lat ?? containing?.data.lat,
        lng: containing?.place?.centroid_lng ?? containing?.data.lng,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayNaps, dayKey, visitsQ.data]);

  const entries: TimelineEntry[] = useMemo(() => {
    const visits = visitsQ.data ?? [];
    const legs = legsQ.data ?? [];
    const spans: Array<PlaceVisit | TravelLeg> = [...visits, ...legs];
    const all: TimelineEntry[] = [
      ...(wakeMoment ? [wakeMoment] : []),
      ...spans,
      ...napMoments,
    ];
    // Sort by EFFECTIVE start within today: a span that began
    // yesterday but continues into today (e.g. overnight Willard with
    // start_ts = 23:35 yesterday) anchors at the day boundary, NOT
    // at its true start_ts. Without this, the wake Moment at 8:26 AM
    // would render AFTER the cross-day Willard visit (which sorts
    // first because its raw start_ts is yesterday). Conceptually
    // wake-up is the first thing that happens today; the visit's
    // effective "today start" is wake-up.
    //
    // Tie-break: when a Moment lands at the same time as a span's
    // effective start, the Moment renders first.
    const effectiveStart = (e: TimelineEntry): string => {
      if (e.kind === 'moment') return e.ts;
      return e.start_ts < fromIso ? fromIso : e.start_ts;
    };
    all.sort((a, b) => {
      const ta = effectiveStart(a);
      const tb = effectiveStart(b);
      if (ta !== tb) return ta < tb ? -1 : 1;
      // Same effective time: Moments first (the wake/nap anchor reads
      // before the span it overlaps with).
      if (a.kind === 'moment' && b.kind !== 'moment') return -1;
      if (b.kind === 'moment' && a.kind !== 'moment') return 1;
      return 0;
    });
    return all;
  }, [visitsQ.data, legsQ.data, wakeMoment, napMoments, fromIso]);

  const lookups = useBuildLookups(visitsQ.data, legsQ.data, chunksQ.data ?? []);

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
  const isLoading =
    sleepQ.isLoading || visitsQ.isLoading || legsQ.isLoading || chunksQ.isLoading;
  const error = sleepQ.error || visitsQ.error || legsQ.error || chunksQ.error;

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
              body={`Day runs 12:00 AM — 12:00 AM local.
Pick a different day, or wait for the deriver to run.`}
            />
          ) : (
            <Timeline
              entries={entries}
              selectedId={selectedId}
              onSelect={setSelectedId}
              dayStartIso={fromIso}
            />
          )}
        </aside>

        <div className="grid grid-rows-[2fr_3fr] min-h-0">
          <div className="relative border-b border-line bg-paper-soft min-h-0">
            <MapPane selected={selected} />
          </div>
          <div className="bg-paper-panel min-h-0 overflow-y-auto">
            <DetailPane entry={selected} dayStartIso={fromIso} />
          </div>
        </div>
      </div>
    </div>
    </TodayLookupsProvider>
  );
}
