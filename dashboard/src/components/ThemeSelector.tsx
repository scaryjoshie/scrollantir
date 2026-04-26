import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ThemeChoice } from '@/lib/settings';

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export default function ThemeSelector({
  value,
  onChange,
}: {
  value: ThemeChoice;
  onChange: (next: ThemeChoice) => void;
}) {
  return (
    <div className="inline-flex items-center p-0.5 rounded-lg bg-paper-panel border border-line">
      {OPTIONS.map(({ value: v, label, icon: Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
              'transition-colors',
              active
                ? 'bg-paper text-ink shadow-card'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            <Icon size={13} strokeWidth={2} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
