import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, format } from 'date-fns';
import { cn } from '@/lib/cn';

export default function DatePicker({
  value,
  onChange,
}: {
  value: Date;
  onChange: (next: Date) => void;
}) {
  const today = startOfLocalDay(new Date());
  const isToday = value.getTime() === today.getTime();

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="p-1.5 rounded-md text-ink-muted hover:bg-paper-hover"
        onClick={() => onChange(addDays(value, -1))}
        aria-label="previous day"
      >
        <ChevronLeft size={16} />
      </button>

      <input
        type="date"
        value={format(value, 'yyyy-MM-dd')}
        onChange={(e) => {
          const [y, m, d] = e.target.value.split('-').map(Number);
          if (!y || !m || !d) return;
          onChange(new Date(y, m - 1, d));
        }}
        className="px-2 py-1 text-sm rounded-md border border-line bg-paper hover:bg-paper-hover
                   focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/15 tabular-nums"
      />

      <button
        type="button"
        className="p-1.5 rounded-md text-ink-muted hover:bg-paper-hover"
        onClick={() => onChange(addDays(value, 1))}
        aria-label="next day"
      >
        <ChevronRight size={16} />
      </button>

      <button
        type="button"
        className={cn('chip ml-2', isToday && 'chip-active')}
        onClick={() => onChange(today)}
      >
        Today
      </button>
    </div>
  );
}

export function startOfLocalDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
