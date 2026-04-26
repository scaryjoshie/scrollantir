import type { AppTime } from '@/lib/types';
import { formatDurationMs, formatPct } from '@/lib/format';

export default function AppBreakdown({
  title,
  apps,
  accent,
  emptyText,
}: {
  title: string;
  apps: AppTime[];
  accent: string;
  emptyText: string;
}) {
  const max = apps.length > 0 ? Math.max(...apps.map((a) => a.ms), 1) : 1;

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {title}
        </h2>
      </div>

      {apps.length === 0 ? (
        <div className="text-sm text-ink-subtle py-6 text-center">{emptyText}</div>
      ) : (
        <ul className="space-y-3">
          {apps.map((a) => {
            const w = Math.max(3, (a.ms / max) * 100);
            return (
              <li key={a.app} className="group">
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="text-sm text-ink truncate" title={a.app}>
                    {a.app}
                  </span>
                  <span className="text-xs text-ink-muted tabular-nums shrink-0">
                    {formatDurationMs(a.ms)} · {formatPct(a.share)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-paper-panel overflow-hidden">
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{ width: `${w}%`, background: accent }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
