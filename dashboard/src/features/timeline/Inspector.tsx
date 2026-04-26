import { format } from 'date-fns';
import { X } from 'lucide-react';
import type { Block } from '@/lib/types';
import { formatDurationMsLong } from '@/lib/format';
import { cn } from '@/lib/cn';
import { colorForSource } from './colors';

type Props = {
  block: Block | null;
  deviceTotalMs?: number;
  appTotalMs?: number;
  onClose: () => void;
};

export default function Inspector({ block, deviceTotalMs, appTotalMs, onClose }: Props) {
  if (!block) return null;

  const color = colorForSource(block.source);
  const duration = block.end_ms - block.start_ms;

  return (
    <aside className="w-[340px] shrink-0 border-l border-line bg-paper-soft flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="inline-block h-3 w-3 rounded-sm shrink-0"
            style={{ background: color.hex }}
          />
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted truncate">
            {block.device} · {block.source}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-ink-subtle hover:bg-paper-hover hover:text-ink"
          aria-label="close inspector"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-4 space-y-4">
          <div>
            <div className="text-lg font-semibold text-ink truncate" title={block.label}>
              {block.label}
            </div>
            <div className="text-xs text-ink-subtle mt-0.5 tabular-nums">
              {format(new Date(block.start_ms), 'EEE MMM d · HH:mm:ss')}
              {' → '}
              {format(new Date(block.end_ms), 'HH:mm:ss')}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Stat label="Duration" value={formatDurationMsLong(duration)} />
            <Stat label="Merged" value={`${block.merged} event${block.merged === 1 ? '' : 's'}`} />
          </div>

          <DetailList>
            {block.app && <Detail k="app" v={block.app} />}
            {block.title && block.title !== block.app && (
              <Detail k="title" v={block.title} />
            )}
            {block.url && <Detail k="url" v={block.url} copy />}
            {block.tags.length > 0 && (
              <Detail k="tags" v={block.tags.join(', ')} />
            )}
          </DetailList>

          {(appTotalMs !== undefined || deviceTotalMs !== undefined) && (
            <div className="border-t border-line pt-3 space-y-1.5">
              {appTotalMs !== undefined && block.app && (
                <Footline
                  k={`${block.app} today`}
                  v={formatDurationMsLong(appTotalMs)}
                />
              )}
              {deviceTotalMs !== undefined && (
                <Footline
                  k={`all ${block.device} today`}
                  v={formatDurationMsLong(deviceTotalMs)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-paper px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-subtle">{label}</div>
      <div className="text-sm text-ink font-medium tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function DetailList({ children }: { children: React.ReactNode }) {
  return <dl className="space-y-2">{children}</dl>;
}

function Detail({ k, v, copy }: { k: string; v: string; copy?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <dt className="text-xs text-ink-subtle w-[50px] shrink-0 uppercase tracking-wider">
        {k}
      </dt>
      <dd
        className={cn(
          'text-ink break-words min-w-0 flex-1',
          copy && 'font-mono text-xs',
        )}
      >
        {v}
      </dd>
    </div>
  );
}

function Footline({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between text-xs">
      <span className="text-ink-subtle">{k}</span>
      <span className="text-ink-muted font-medium tabular-nums">{v}</span>
    </div>
  );
}
