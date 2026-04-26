import { format, formatDistanceToNow, parseISO } from 'date-fns';
import type { Report } from '@/lib/types';
import { cn } from '@/lib/cn';

const TAG_HUE: Record<string, string> = {
  daily:
    'bg-[#E7F0F9] text-[#2383E2] dark:bg-[#1B324C] dark:text-[#7CB3EC]',
  weekly:
    'bg-[#F1EAF7] text-[#7C58A8] dark:bg-[#2E2340] dark:text-[#B794D6]',
  smoke:
    'bg-[#F4EFE6] text-[#997A3E] dark:bg-[#2E281D] dark:text-[#D6B470]',
};

export default function ReportCard({
  report,
  selected,
  onClick,
}: {
  report: Report;
  selected: boolean;
  onClick: () => void;
}) {
  const created = parseISO(report.created_at);
  const preview = bodyPreview(report.body);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-left w-full rounded-card border transition-colors px-4 py-3',
        'bg-paper',
        selected
          ? 'border-accent/40 bg-accent-soft/50'
          : 'border-line hover:bg-paper-soft',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-ink truncate">
              {report.title || 'Untitled'}
            </div>
            <div className="flex items-center gap-1">
              {report.tags.map((t) => (
                <span
                  key={t}
                  className={cn(
                    'rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase',
                    TAG_HUE[t] ?? 'bg-paper-panel text-ink-subtle',
                  )}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
          {preview && (
            <div className="text-sm text-ink-muted mt-1 line-clamp-2">
              {preview}
            </div>
          )}
          <div className="text-xs text-ink-subtle mt-2 tabular-nums">
            {format(created, 'MMM d, yyyy · HH:mm')} ·{' '}
            {formatDistanceToNow(created, { addSuffix: true })}
          </div>
        </div>
      </div>
    </button>
  );
}

function bodyPreview(body: string) {
  return body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
