import { useEffect } from 'react';
import { useSettings, type ThemeChoice } from './settings';

function resolvedTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'light' || choice === 'dark') return choice;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(mode: 'light' | 'dark') {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.style.colorScheme = mode;
}

export function useApplyTheme() {
  const [settings] = useSettings();
  const choice = settings.theme;

  useEffect(() => {
    apply(resolvedTheme(choice));

    if (choice !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => apply(resolvedTheme('system'));
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [choice]);
}
