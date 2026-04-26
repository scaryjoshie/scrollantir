import type { ReactNode } from 'react';

export default function EmptyState({
  title,
  body,
  icon,
}: {
  title: string;
  body?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {icon && <div className="text-ink-subtle mb-3">{icon}</div>}
      <div className="text-ink font-medium">{title}</div>
      {body && <div className="text-sm text-ink-subtle mt-1 max-w-sm">{body}</div>}
    </div>
  );
}
