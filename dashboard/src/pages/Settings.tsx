import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import Toggle from '@/components/Toggle';
import ThemeSelector from '@/components/ThemeSelector';
import { fetchHealth } from '@/lib/api';
import { useSettings } from '@/lib/settings';
import { cn } from '@/lib/cn';

export default function SettingsPage() {
  const [settings, update] = useSettings();
  const { data: health, error } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 30_000,
  });

  const ok = !!health && !error;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader
        title="Settings"
        subtitle="Stored locally in your browser. No server state."
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[640px] mx-auto py-8 px-10 space-y-8">
          <Section title="Appearance">
            <div className="flex items-center justify-between py-3 gap-4">
              <div className="min-w-0">
                <div className="text-sm text-ink font-medium">Theme</div>
                <div className="text-xs text-ink-subtle mt-0.5 leading-snug">
                  System follows your OS preference.
                </div>
              </div>
              <ThemeSelector
                value={settings.theme}
                onChange={(theme) => update({ theme })}
              />
            </div>
          </Section>

          <Section title="Timeline filters">
            <Toggle
              checked={settings.hideDetectorMiss}
              onChange={(v) => update({ hideDetectorMiss: v })}
              label="Hide detector misses"
              description="detector.miss events are debug-only diagnostics emitted by the Android content detector when it sees a target app but no rule matched. Hidden by default."
            />
            <Divider />
            <Toggle
              checked={settings.hideAfk}
              onChange={(v) => update({ hideAfk: v })}
              label="Hide AFK / idle periods"
              description="system.afk spans on Mac mark away-from-keyboard stretches. Toggle on to show only active time."
            />
          </Section>

          <Section title="Connection">
            <div className="flex items-center justify-between py-3">
              <div>
                <div className="text-sm text-ink font-medium">Supabase (user_role)</div>
                <div className="text-xs text-ink-subtle mt-0.5">
                  Read-only access to <span className="font-mono">public.*</span> via the DSN in your macOS keychain.
                </div>
              </div>
              <StatusPill ok={ok} />
            </div>
            {health && (
              <div className="text-xs text-ink-subtle pb-3 tabular-nums">
                db time: {health.now}
              </div>
            )}
            {error && (
              <div className="text-xs text-danger pb-3 break-all">
                {(error as Error).message}
              </div>
            )}
          </Section>

          <Section title="About">
            <div className="space-y-2 py-2 text-sm text-ink-muted">
              <p>
                Scrollantir dashboard v1 — reports + a 24-hour timeline across
                your Mac and phone. Everything shown is read straight from your
                own Postgres; nothing leaves this machine.
              </p>
              <p className="text-xs text-ink-subtle">
                Location lane is intentionally blank until the{' '}
                <span className="font-mono">place_visits</span> /{' '}
                <span className="font-mono">travel_legs</span> derivation ships.
              </p>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle mb-2 px-1">
        {title}
      </h2>
      <div className="card px-4 divide-y divide-line/60">{children}</div>
    </section>
  );
}

function Divider() {
  return <div className="border-t border-line/60 -mx-4" />;
}

function StatusPill({ ok }: { ok: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
        ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger',
      )}
    >
      {ok ? <Check size={12} strokeWidth={2.5} /> : <X size={12} strokeWidth={2.5} />}
      {ok ? 'connected' : 'offline'}
    </div>
  );
}
