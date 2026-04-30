import { NavLink, Outlet } from 'react-router-dom';
import {
  Activity,
  FileText,
  Gauge,
  Settings as SettingsIcon,
  Sun,
  TrendingUp,
} from 'lucide-react';
import { cn } from '@/lib/cn';

// /summary + /trends sit between /today (per-session drill) and
// /reports (LLM narratives). The order is roughly "what's happening
// right now" → "today's narrative" → "how today rolls up" → "how the
// week looks" → "agent-written summaries."
const NAV = [
  { to: '/', label: 'Raw', icon: Activity, end: true },
  { to: '/today', label: 'Today', icon: Sun },
  { to: '/summary', label: 'At a glance', icon: Gauge },
  { to: '/trends', label: 'Trends', icon: TrendingUp },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export default function Layout() {
  return (
    <div className="h-full grid grid-cols-[220px_1fr] bg-paper-soft">
      <aside className="border-r border-line bg-paper-panel flex flex-col">
        <div className="px-4 pt-5 pb-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span
              className="inline-block w-5 h-5 rounded-md"
              style={{
                background:
                  'linear-gradient(135deg,#6B8EF2 0%,#C79BD8 60%,#7DB98A 100%)',
              }}
            />
            Scrollantir
          </div>
          <div className="text-xs text-ink-subtle mt-1 pl-7">palantir for yourself</div>
        </div>

        <nav className="px-2 flex flex-col gap-0.5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              className={({ isActive }) =>
                cn('nav-item', isActive && 'nav-item-active')
              }
            >
              <item.icon size={15} strokeWidth={1.75} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto px-4 py-3 text-xs text-ink-subtle border-t border-line">
          <div>
            Reading <span className="text-ink-muted">public.*</span> as{' '}
            <span className="text-ink-muted">user_role</span>
          </div>
          <div className="mt-0.5">via PostgREST + Caddy basic_auth</div>
        </div>
      </aside>

      <main className="min-w-0 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
