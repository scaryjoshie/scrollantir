import { useCallback, useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';

export type Settings = {
  hideDetectorMiss: boolean;
  hideAfk: boolean;
  theme: ThemeChoice;
};

const DEFAULTS: Settings = {
  hideDetectorMiss: true,
  hideAfk: false,
  theme: 'system',
};

const STORAGE_KEY = 'scrollantir.settings.v1';

function read(): Settings {
  if (typeof localStorage === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function write(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    window.dispatchEvent(new CustomEvent('scrollantir-settings'));
  } catch {
    /* ignore quota errors */
  }
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [state, setState] = useState<Settings>(read);

  useEffect(() => {
    const handler = () => setState(read());
    window.addEventListener('scrollantir-settings', handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener('scrollantir-settings', handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      write(next);
      return next;
    });
  }, []);

  return [state, update];
}

export function hiddenSources(s: Settings): string[] {
  const out: string[] = [];
  if (s.hideDetectorMiss) out.push('detector.miss');
  if (s.hideAfk) out.push('system.afk');
  // Raw location / activity pings — not meaningful on the timeline until the
  // place_visits / travel_legs derivation lands. Always hidden for now.
  out.push('phone.location.reading', 'phone.activity.state');
  return out;
}
