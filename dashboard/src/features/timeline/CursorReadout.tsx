import { format } from 'date-fns';
import type { Block } from '@/lib/types';
import { cn } from '@/lib/cn';

type Props = {
  time: Date | null;
  macBlock: Block | null;
  phoneBlock: Block | null;
};

export default function CursorReadout({ time, macBlock, phoneBlock }: Props) {
  if (!time) {
    return (
      <div className="text-xs text-ink-subtle">
        hover the timeline to read across lanes
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 text-xs min-w-0 flex-wrap">
      <span className="text-ink-muted font-medium tabular-nums shrink-0">
        {format(time, 'HH:mm:ss')}
      </span>
      <Chip tone="mac" label="Mac" block={macBlock} />
      <Chip tone="phone" label="Phone" block={phoneBlock} />
    </div>
  );
}

function Chip({
  tone,
  label,
  block,
}: {
  tone: 'mac' | 'phone';
  label: string;
  block: Block | null;
}) {
  const dot: Record<string, string> = {
    mac: 'bg-[#6B8EF2]',
    phone: 'bg-[#7DB98A]',
  };

  return (
    <div className="flex items-center gap-1.5 min-w-0 max-w-[320px]">
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', dot[tone])} />
      <span className="text-ink-subtle shrink-0">{label}</span>
      <span className="text-ink truncate" title={block?.app ?? block?.label ?? undefined}>
        {block ? (block.app ?? block.label) : (
          <span className="text-ink-subtle italic">idle</span>
        )}
      </span>
    </div>
  );
}
