export function formatDurationMs(ms: number): string {
  if (ms <= 0) return '0m';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 && m < 10 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function formatDurationMsLong(ms: number): string {
  if (ms <= 0) return '0m';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (h === 0 && s > 0) parts.push(`${s}s`);
  return parts.join(' ') || '0m';
}

export function formatPct(share: number): string {
  const p = share * 100;
  if (p < 1) return '<1%';
  return `${Math.round(p)}%`;
}
