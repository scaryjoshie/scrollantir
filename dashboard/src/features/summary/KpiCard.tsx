import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export default function KpiCard({
  label,
  value,
  sub,
  tone = 'default',
  icon,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  tone?: 'default' | 'mac' | 'phone' | 'concurrent';
  icon?: ReactNode;
}) {
  const dot: Record<string, string> = {
    default: 'bg-ink-subtle',
    mac: 'bg-[#6B8EF2]',
    phone: 'bg-[#7DB98A]',
    concurrent: 'bg-[#C79BD8]',
  };

  return (
    <div className="card px-5 py-4 flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-ink-subtle">
        <span className={cn('inline-block h-2 w-2 rounded-full', dot[tone])} />
        <span>{label}</span>
        {icon && <span className="ml-auto text-ink-subtle">{icon}</span>}
      </div>
      <div className="text-3xl font-bold text-ink tabular-nums tracking-tight">{value}</div>
      {sub && <div className="text-xs text-ink-subtle leading-snug">{sub}</div>}
    </div>
  );
}
