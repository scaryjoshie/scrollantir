import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, AlertCircle } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import FilterChips, { type ChipOption } from '@/components/FilterChips';
import EmptyState from '@/components/EmptyState';
import ReportCard from '@/features/reports/ReportCard';
import ReportDetail from '@/features/reports/ReportDetail';
import { fetchReports } from '@/lib/api';
import type { Report } from '@/lib/types';

type Filter = 'all' | 'daily' | 'weekly';

export default function ReportsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['reports'],
    queryFn: () => fetchReports(50),
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reports = data ?? [];
  const counts = useMemo(() => {
    return reports.reduce(
      (acc, r) => {
        acc.all += 1;
        if (r.tags.includes('daily')) acc.daily += 1;
        if (r.tags.includes('weekly')) acc.weekly += 1;
        return acc;
      },
      { all: 0, daily: 0, weekly: 0 },
    );
  }, [reports]);

  const filtered = useMemo(() => {
    if (filter === 'all') return reports;
    return reports.filter((r) => r.tags.includes(filter));
  }, [reports, filter]);

  const selected: Report | null =
    filtered.find((r) => r.id === selectedId) ?? filtered[0] ?? null;

  const options: ChipOption<Filter>[] = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'daily', label: 'Daily', count: counts.daily },
    { value: 'weekly', label: 'Weekly', count: counts.weekly },
  ];

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Reports"
        subtitle="Agent-written daily and weekly digests from public.reports."
        right={
          <FilterChips
            options={options}
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setSelectedId(null);
            }}
          />
        }
      />

      <div className="grid grid-cols-[380px_1fr] min-h-0 flex-1">
        <aside className="border-r border-line overflow-y-auto bg-paper-soft">
          <div className="flex flex-col gap-2 px-4 py-4">
            {isLoading && <SkeletonList />}
            {error && (
              <div className="flex items-start gap-2 text-sm text-danger bg-danger-soft border border-danger/20 rounded-card p-3">
                <AlertCircle size={16} className="mt-0.5" />
                <div>
                  <div className="font-medium">Failed to load reports</div>
                  <div className="text-xs opacity-80 mt-0.5 break-all">
                    {(error as Error).message}
                  </div>
                </div>
              </div>
            )}
            {!isLoading && !error && filtered.length === 0 && (
              <EmptyState
                icon={<FileText size={24} strokeWidth={1.5} />}
                title="No reports yet"
                body="Daily digests land at 07:00 CT; weekly reports on Sundays at 09:00 CT."
              />
            )}
            {filtered.map((r) => (
              <ReportCard
                key={r.id}
                report={r}
                selected={selected?.id === r.id}
                onClick={() => setSelectedId(r.id)}
              />
            ))}
          </div>
        </aside>

        <section className="overflow-y-auto bg-paper">
          {selected ? (
            <ReportDetail report={selected} />
          ) : (
            !isLoading && (
              <EmptyState
                title="Select a report"
                body="Pick a card on the left to read the body."
              />
            )
          )}
        </section>
      </div>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2 animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-[88px] rounded-card bg-paper-panel border border-line" />
      ))}
    </div>
  );
}
