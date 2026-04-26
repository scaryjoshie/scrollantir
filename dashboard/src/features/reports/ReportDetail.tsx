import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { format, parseISO } from 'date-fns';
import type { Report } from '@/lib/types';

export default function ReportDetail({ report }: { report: Report }) {
  const created = parseISO(report.created_at);
  const ws = report.window_start ? parseISO(report.window_start) : null;
  const we = report.window_end ? parseISO(report.window_end) : null;

  return (
    <article className="max-w-[720px] mx-auto py-10 px-10">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-ink">
          {report.title || 'Untitled'}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle tabular-nums">
          <span>{format(created, 'EEEE, MMM d, yyyy · HH:mm')}</span>
          {ws && we && (
            <>
              <span>·</span>
              <span>
                window {format(ws, 'MMM d HH:mm')} → {format(we, 'MMM d HH:mm')}
              </span>
            </>
          )}
          {report.tags.length > 0 && (
            <>
              <span>·</span>
              <span>tags: {report.tags.join(', ')}</span>
            </>
          )}
        </div>
      </div>

      <div className="prose-notion">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.body}</ReactMarkdown>
      </div>
    </article>
  );
}
