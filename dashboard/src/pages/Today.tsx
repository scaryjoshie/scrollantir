import { useEffect, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import PageHeader from '@/components/PageHeader';
import DatePicker, { startOfLocalDay } from '@/components/DatePicker';
import EmptyState from '@/components/EmptyState';
import Timeline from '@/features/today/Timeline';
import MapPane from '@/features/today/MapPane';
import DetailPane from '@/features/today/DetailPane';
import { fixtureDate, timelineEntries } from '@/features/today/fixtures';

// "Day" boundary for the dashboard runs 04:00 → 04:00 the next morning,
// so late-night activity (past midnight but before bed) belongs to the
// previous calendar date's view. Once real fetchers ship, the SQL query
// for entries will be:
//   start_ts >= :selectedDay_04:00  AND  start_ts < :nextDay_04:00
const DAY_BOUNDARY_HOUR = 4;

export default function TodayPage() {
  // Default to the fixture date so the page lands on data on first visit.
  const [day, setDay] = useState<Date>(() =>
    startOfLocalDay(parseISO(`${fixtureDate}T00:00:00`)),
  );

  // Mock: only the fixtureDate has data. Other days render empty so the
  // picker is exercise-able without backend wiring.
  const isFixtureDay = format(day, 'yyyy-MM-dd') === fixtureDate;
  const entries = isFixtureDay ? timelineEntries : [];

  const [selectedId, setSelectedId] = useState<string | null>(
    () => entries[0]?.id ?? null,
  );

  // Reset selection to the day's first entry whenever the day changes,
  // so we never point at an entry that isn't in the current view.
  const dayKey = format(day, 'yyyy-MM-dd');
  useEffect(() => {
    setSelectedId(entries[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const subtitle = format(day, 'EEEE');

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Today"
        subtitle={subtitle}
        right={<DatePicker value={day} onChange={setDay} />}
      />

      <div className="grid grid-cols-[400px_1fr] min-h-0 flex-1">
        <aside className="border-r border-line bg-paper-panel overflow-y-auto">
          {entries.length === 0 ? (
            <EmptyState
              title="No data for this day"
              body={`Day boundary runs ${DAY_BOUNDARY_HOUR}:00 → ${DAY_BOUNDARY_HOUR}:00.
Pick a different day or jump back to the fixture day.`}
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
  );
}
