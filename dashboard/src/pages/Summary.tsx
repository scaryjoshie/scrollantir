import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertCircle, Info } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import DatePicker, { startOfLocalDay } from '@/components/DatePicker';
import KpiCard from '@/features/summary/KpiCard';
import AppBreakdown from '@/features/summary/AppBreakdown';
import { fetchSummary } from '@/lib/api';
import { formatDurationMs, formatDurationMsLong, formatPct } from '@/lib/format';

const DAY_MS = 24 * 3600 * 1000;

export default function SummaryPage() {
  const [day, setDay] = useState<Date>(() => startOfLocalDay(new Date()));
  const dayEnd = useMemo(
    () => new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
    [day],
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ['summary', day.toISOString()],
    queryFn: () => fetchSummary(day.toISOString(), dayEnd.toISOString()),
    staleTime: 60_000,
  });

  const awSaysIdleHours = data ? data.mac_afk_ms / 3600_000 : 0;
  const showAwNote = awSaysIdleHours > 4;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Summary"
        subtitle={format(day, 'EEEE, MMM d, yyyy')}
        right={<DatePicker value={day} onChange={setDay} />}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1040px] mx-auto py-8 px-10 space-y-6">
          {error && (
            <div className="flex items-start gap-2 text-sm text-danger bg-danger-soft border border-danger/20 rounded-card p-3">
              <AlertCircle size={16} className="mt-0.5" />
              <div>
                <div className="font-medium">Failed to load summary</div>
                <div className="text-xs opacity-80 mt-0.5 break-all">
                  {(error as Error).message}
                </div>
              </div>
            </div>
          )}

          {isLoading && !data ? (
            <SkeletonRow />
          ) : (
            data && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <KpiCard
                    tone="mac"
                    label="On Mac"
                    value={formatDurationMs(data.mac_active_ms)}
                    sub={
                      <span>
                        {pctOfDay(data.mac_active_ms)} of the day
                        {data.mac_only_ms > 0 && (
                          <> · {formatDurationMs(data.mac_only_ms)} solo</>
                        )}
                      </span>
                    }
                  />
                  <KpiCard
                    tone="phone"
                    label="On phone"
                    value={formatDurationMs(data.phone_active_ms)}
                    sub={
                      <span>
                        {pctOfDay(data.phone_active_ms)} of the day
                        {data.phone_only_ms > 0 && (
                          <> · {formatDurationMs(data.phone_only_ms)} solo</>
                        )}
                      </span>
                    }
                  />
                  <KpiCard
                    tone="concurrent"
                    label="Both at once"
                    value={formatDurationMs(data.concurrent_ms)}
                    sub={
                      <span>
                        {pctOfDay(data.concurrent_ms)} of the day · phone time
                        overlapping Mac active
                      </span>
                    }
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <SecondaryStat
                    label="Idle"
                    value={formatDurationMs(data.derived_idle_ms)}
                    sub={`gaps ≥ ${Math.round(data.derived_idle_threshold_ms / 60000)} min with no Mac focus and no phone activity`}
                  />
                  <SecondaryStat
                    label="AW AFK (ignored)"
                    value={formatDurationMs(data.mac_afk_ms)}
                    sub="ActivityWatch's reading — known unreliable, kept for comparison"
                    tone="dim"
                  />
                </div>

                {showAwNote && (
                  <div className="flex items-start gap-2 text-xs text-ink-muted bg-paper-soft border border-line rounded-card px-3 py-2.5">
                    <Info size={14} className="mt-0.5 shrink-0 text-ink-subtle" />
                    <div>
                      AW said <span className="font-medium text-ink">{formatDurationMs(data.mac_afk_ms)}</span> AFK today — that reading isn't used here. Mac active is derived from raw focus coverage; idle is inferred from ≥{Math.round(data.derived_idle_threshold_ms / 60000)}-min gaps with no activity on either device.
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <AppBreakdown
                    title="Top Mac apps"
                    apps={data.top_mac_apps}
                    accent="#6B8EF2"
                    emptyText="No Mac app events in this window."
                  />
                  <AppBreakdown
                    title="Top phone apps"
                    apps={data.top_phone_apps}
                    accent="#7DB98A"
                    emptyText="No phone events in this window."
                  />
                </div>

                <div className="text-xs text-ink-subtle flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
                  <span>analyzed {data.events_total.toLocaleString()} events</span>
                  <span>·</span>
                  <span>
                    mac focus coverage {formatDurationMsLong(data.mac_focus_ms)} ·
                    derived idle {formatDurationMsLong(data.derived_idle_ms)}
                  </span>
                </div>
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function pctOfDay(ms: number): string {
  return formatPct(ms / DAY_MS);
}

function SecondaryStat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'default' | 'dim';
}) {
  return (
    <div className={`card px-5 py-4 ${tone === 'dim' ? 'opacity-70' : ''}`}>
      <div className="text-xs font-medium uppercase tracking-wider text-ink-subtle mb-1">
        {label}
      </div>
      <div className="text-xl font-semibold text-ink tabular-nums">{value}</div>
      <div className="text-xs text-ink-subtle mt-1 leading-snug">{sub}</div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 animate-pulse">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-[96px] card" />
      ))}
    </div>
  );
}
