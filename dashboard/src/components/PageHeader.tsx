import type { ReactNode } from 'react';

export default function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-line px-10 pt-8 pb-5 bg-paper">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && (
          <p className="text-sm text-ink-subtle mt-1">{subtitle}</p>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}
