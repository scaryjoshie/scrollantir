import { cn } from '@/lib/cn';

export type ChipOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
};

export default function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly ChipOption<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn('chip', active && 'chip-active')}
          >
            {opt.label}
            {typeof opt.count === 'number' && (
              <span
                className={cn(
                  'text-[10px] font-normal tabular-nums',
                  active ? 'text-accent/70' : 'text-ink-subtle',
                )}
              >
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
