export type SourceColor = {
  className: string;
  hex: string;
  label: string;
};

const PALETTE: Record<string, SourceColor> = {
  'system.foreground': { className: 'src-sys-fg', hex: '#6B8EF2', label: 'Foreground app' },
  'system.window':     { className: 'src-sys-win', hex: '#8FA8F2', label: 'Window focus' },
  'zen.tab':           { className: 'src-zen', hex: '#A78BFA', label: 'Zen browser tab' },
  'system.afk':        { className: 'src-afk', hex: '#C9C8C3', label: 'Away from keyboard' },
  'system.screen':     { className: 'src-screen', hex: '#F3C969', label: 'Screen on' },
  'system.unlock':     { className: 'src-unlock', hex: '#86C48B', label: 'Unlock' },
  'system.unlocked':   { className: 'src-unlock', hex: '#86C48B', label: 'Unlock' },
  'youtube.shorts':    { className: 'src-shortform', hex: '#F29393', label: 'Short-form video' },
  'instagram.reels':   { className: 'src-shortform', hex: '#F29393', label: 'Short-form video' },
  'tiktok.feed':       { className: 'src-shortform', hex: '#F29393', label: 'Short-form video' },
  'detector.miss':     { className: 'src-miss', hex: '#D6D3D1', label: 'Detector miss' },
};

const DEFAULT: SourceColor = { className: 'src-default', hex: '#BBB9B3', label: 'Other' };

export function colorForSource(source: string): SourceColor {
  return PALETTE[source] ?? DEFAULT;
}

export function legendEntries(): SourceColor[] {
  const seen = new Set<string>();
  const out: SourceColor[] = [];
  for (const v of Object.values(PALETTE)) {
    if (seen.has(v.className)) continue;
    seen.add(v.className);
    out.push(v);
  }
  out.push(DEFAULT);
  return out;
}
