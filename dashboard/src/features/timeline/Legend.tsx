import { legendEntries } from './colors';

export default function Legend() {
  const entries = legendEntries();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-muted">
      {entries.map((e) => (
        <div key={e.className} className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-[3px]"
            style={{ background: e.hex }}
          />
          <span>{e.label}</span>
        </div>
      ))}
    </div>
  );
}
