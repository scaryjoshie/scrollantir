import { cn } from '@/lib/cn';

export default function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex items-start gap-3 py-3 cursor-pointer select-none">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'mt-0.5 relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
          'border border-line',
          checked ? 'bg-accent border-accent' : 'bg-paper-panel',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-card transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </button>
      <div className="min-w-0">
        <div className="text-sm text-ink font-medium leading-tight">{label}</div>
        {description && (
          <div className="text-xs text-ink-subtle mt-0.5 leading-snug">{description}</div>
        )}
      </div>
    </label>
  );
}
