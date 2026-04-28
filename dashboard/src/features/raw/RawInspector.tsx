import { format, parseISO } from 'date-fns';
import type { DashboardEvent } from '@/lib/types';

type Props = { event: DashboardEvent | null };

export default function RawInspector({ event }: Props) {
  if (!event) {
    return (
      <div className="p-6 text-sm text-ink-subtle">
        Click an event in the timeline to inspect.
      </div>
    );
  }
  return (
    <div className="p-5 flex flex-col gap-4 text-sm">
      <Field label="source" mono>
        {event.source}
      </Field>
      <Field label="device" mono>
        {event.device}
      </Field>
      <Field label="start" mono small>
        {fmt(event.start_ts)}
      </Field>
      <Field label="end" mono small>
        {fmt(event.end_ts)}
      </Field>
      <Field label="duration" mono>
        {event.duration_s.toFixed(2)}s
      </Field>
      <Field label="id" mono small>
        {event.id}
      </Field>
      <div>
        <FieldLabel>data</FieldLabel>
        <pre className="font-mono text-xs bg-paper-soft border border-line/60 p-3 rounded overflow-auto max-h-[480px]">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function fmt(iso: string): string {
  try {
    return format(parseISO(iso), 'yyyy-MM-dd HH:mm:ss.SSS');
  } catch {
    return iso;
  }
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] text-ink-subtle uppercase tracking-wider mb-1">
      {children}
    </div>
  );
}

function Field({
  label,
  children,
  mono,
  small,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div
        className={
          (mono ? 'font-mono ' : '') + (small ? 'text-xs ' : 'text-sm ') + 'break-all'
        }
      >
        {children}
      </div>
    </div>
  );
}
