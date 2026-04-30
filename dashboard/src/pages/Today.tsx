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
  PlaceVisit,
  Sleep,
  TimelineEntry,
  TrackingGap,
  UserActiveSpan,
} from '@/features/today/types';
import {
  TodayLookupsProvider,
  useBuildLookups,
} from '@/features/today/lookups';
import {
  fetchPlaceVisits,
  fetchSleepByWakeDates,
  fetchTravelLegs,
  fetchUserActive,
} from '@/lib/api';

// Day window is strictly local 00:00 → 24:00. Visits/legs that span
// midnight render on BOTH days, clipped to each day's window by the
// timeline's display logic. Sleep renders as a span on the timeline
// (kind='sleep'), anchored at wake-time so a night that started at
// 23:48 yesterday appears in today's narrative at the 8:26 AM wake,
// not at the top.
function dayWindow(day: Date): { fromIso: string; toIso: string } {
  const from = new Date(day);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

// Threshold for inserting a synthetic 'tracking_gap' entry. Tuned to
// 30 min by intuition; the 4/29 dark window was 11.5h, which is
// orders of magnitude above this floor. 30 min is short enough to
// catch a Doze-induced hole over an afternoon, long enough to skip
// trivial inter-entry whitespace from rounding.
//
// Smaller threshold (~15 min) would surface more borderline cases but
// also more visual noise. Tenet 4: revisit once we have real Doze-vs-
// real-stillness data to compare distributions.
const TRACKING_GAP_THRESHOLD_MS = 30 * 60 * 1000;

// Walk the sorted-but-no-gaps entry list and synthesize 'tracking_gap'
// entries for each consecutive pair separated by more than the
// threshold. Skips:
//   - chunks (inline under their parent; gaps between chunks are not
//     tracking failures, just normal inter-chunk whitespace)
//   - the day's edges (before first entry / after last) — those aren't
//     "tracking gaps", they're "before today started" / "future"
//
// NOTE: an earlier revision (commit 10d2e60) added a trailing gap from
// the last entry's end to "now" on today's view. That was the wrong
// framing — when there's user_active data (e.g. phone foreground at 3
// AM) but no place_visit, we DO have data; it just hasn't been promoted
// to a visit. The correct fix is to surface user_active rows directly,
// which the entries memo now does. Tracking gaps remain useful for true
// blackouts where neither visit nor user_active rows exist between two
// real entries.
//
// The returned entries are inserted inline so the chronological sort
// reads naturally without re-sorting.
function synthesizeTrackingGaps(entries: TimelineEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i];
    out.push(cur);
    const next = entries[i + 1];
    if (!next) break;
    if (cur.kind === 'topic_chunk' || next.kind === 'topic_chunk') continue;
    const curEnd = entryEnd(cur);
    const nextStart = entryStart(next);
    if (!curEnd || !nextStart) continue;
    const gapMs = Date.parse(nextStart) - Date.parse(curEnd);
    if (gapMs < TRACKING_GAP_THRESHOLD_MS) continue;
    const gap: TrackingGap = {
      kind: 'tracking_gap',
      id: `gap-${curEnd}-${nextStart}`,
      start_ts: curEnd,
      end_ts: nextStart,
      adjacent_to_sleep: cur.kind === 'sleep' || next.kind === 'sleep',
    };
    out.push(gap);
  }
  return out;
}

// Minimum effective-uncovered duration for a user_active span to surface
// on the timeline. Below this, the span is just inter-visit jitter that
// doesn't merit its own row. 5 min is short enough to catch a real
// "active on Mac for 8 minutes between visits" while filtering out
// borderline-trivial fragments.
const USER_ACTIVE_MIN_UNCOVERED_MS = 5 * 60 * 1000;

// Compute how many milliseconds of [span.start_ts, span.end_ts] are NOT
// covered by any place_visit. A span is kept on the timeline iff this
// uncovered duration exceeds USER_ACTIVE_MIN_UNCOVERED_MS — at which
// point we render it as the dominant signal. The span itself is NOT
// clipped on render: showing its full range matches the deriver's
// truth ("the device was used from X to Y") and visiting overlap is
// rare in practice (visits cap span growth via the same activity
// backbone).
function uncoveredMs(span: UserActiveSpan, visits: PlaceVisit[]): number {
  const s = Date.parse(span.start_ts);
  const e = Date.parse(span.end_ts);
  let covered = 0;
  for (const v of visits) {
    const vs = Date.parse(v.start_ts);
    const ve = Date.parse(v.end_ts);
    if (ve <= s || vs >= e) continue;
    covered += Math.min(ve, e) - Math.max(vs, s);
  }
  return e - s - covered;
}

// Effective end_ts for gap detection. Moments are point-in-time; their
// end == start. Sleep ends at end_ts (wake). Spans end at end_ts.
function entryEnd(e: TimelineEntry): string | null {
  if (e.kind === 'moment') return e.ts;
  if (e.kind === 'topic_chunk') return null; // skipped by caller
  if (e.kind === 'tracking_gap') return e.end_ts;
  return e.end_ts;
}

// Effective start_ts for gap detection. Mirrors entryEnd.
function entryStart(e: TimelineEntry): string | null {
  if (e.kind === 'moment') return e.ts;
  if (e.kind === 'topic_chunk') return null;
  if (e.kind === 'tracking_gap') return e.start_ts;
  return e.start_ts;
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
  // user_active spans surface on the timeline ONLY when they aren't
  // covered by a place_visit — that's the "device active but no visit
  // emitted" case (sub-dwell stop, location lag, etc.). Without this,
  // /today falsely reads as a "Tracking gap" when raw data exists.
  const userActiveQ = useQuery({
    queryKey: ['user_active', fromIso, toIso],
    queryFn: () => fetchUserActive(fromIso, toIso),
  });
  // project_chunks are NOT fetched at the day level. DetailPane fetches
  // per-parent on selection (~5–30 rows vs 312/day). React Query
  // caches per parent_id so re-selection is instant. Drops ~10KB
  // of compressed wire on every /today load.

  const entries: TimelineEntry[] = useMemo(() => {
    const visits = visitsQ.data ?? [];
    const legs = legsQ.data ?? [];
    const sleeps: Sleep[] = [];
    if (todayNight) sleeps.push(todayNight);
    sleeps.push(...todayNaps);

    // Drop user_active spans that are mostly covered by a place_visit
    // (the visit IS the better summary). What's left = "active, not at
    // a known place" — the user sees an honest "Active on Mac" row
    // instead of a false "Tracking gap" when, say, the deriver hasn't
    // yet promoted a 3-min stay to a place_visit.
    const userActive = (userActiveQ.data ?? []).filter(
      (span) => uncoveredMs(span, visits) > USER_ACTIVE_MIN_UNCOVERED_MS,
    );

    const all: TimelineEntry[] = [...visits, ...legs, ...sleeps, ...userActive];

    // Sort by EFFECTIVE position within today.
    //
    // For most entries, that's the start_ts (or fromIso clip if the
    // span began before today, e.g. an overnight Willard visit).
    //
    // For sleep entries (kind='sleep'), anchor at end_ts (the wake
    // time) instead — a 'night' sleep starts yesterday at 23:48 but
    // the user reads it as "woke up at 8:26", which is when it
    // appears in their day. This also keeps the night-sleep row
    // adjacent to the morning chunk that follows it, instead of
    // pinning to the top.
    const effectiveStart = (e: TimelineEntry): string => {
      if (e.kind === 'moment') return e.ts;
      if (e.kind === 'sleep') return e.end_ts;
      if (e.kind === 'tracking_gap') return e.start_ts;
      if (e.kind === 'user_active') return e.start_ts;
      return e.start_ts < fromIso ? fromIso : e.start_ts;
    };
    all.sort((a, b) => {
      const ta = effectiveStart(a);
      const tb = effectiveStart(b);
      if (ta !== tb) return ta < tb ? -1 : 1;
      // Tie-break: Moments / sleep lead the span at the same time.
      if (a.kind !== 'place_visit' && b.kind === 'place_visit') return -1;
      if (b.kind !== 'place_visit' && a.kind === 'place_visit') return 1;
      return 0;
    });
    // Synthesize 'tracking_gap' entries for stretches of silence
    // between consecutive entries. Done AFTER sort so the gaps are
    // inserted in chronological position. Chunks aren't fetched at
    // the day level (DetailPane fetches per-parent), so the input
    // here is naturally chunk-free — the topic_chunk skip in the
    // helper is defensive in case the data flow changes.
    //
    // The trailing-gap-to-now (commit 10d2e60) was REMOVED: when raw
    // user_active rows exist past the last visit, they now render as
    // honest "Active" entries instead of pretending the device was
    // dark. True trailing blackouts (no user_active rows either) just
    // appear as silence — which is accurate, since we can't tell apart
    // "phone in pocket" from "phone in Doze".
    return synthesizeTrackingGaps(all);
  }, [visitsQ.data, legsQ.data, userActiveQ.data, todayNight, todayNaps, fromIso]);

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
  const isLoading =
    sleepQ.isLoading || visitsQ.isLoading || legsQ.isLoading || userActiveQ.isLoading;
  const error =
    sleepQ.error || visitsQ.error || legsQ.error || userActiveQ.error;

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
              dayEndIso={toIso}
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
