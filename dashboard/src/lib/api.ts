// Thin PostgREST client. All requests go through Vite's /api proxy
// (dev) or Caddy reverse-proxy (prod); same code path in both.
//
// Auth: HTTP Basic with credentials from VITE_DASHBOARD_USER /
// VITE_DASHBOARD_PASSWORD (set in .env.local). Caddy gates every
// request via basic_auth; without creds you get 401.

import type { DashboardEvent, Report } from './types';
import type {
  PlaceVisit,
  Sleep,
  TravelLeg,
} from '@/features/today/types';

const USER = (import.meta.env.VITE_DASHBOARD_USER as string) || 'josh';
const PASSWORD = (import.meta.env.VITE_DASHBOARD_PASSWORD as string) || '';

const AUTH_HEADER: Record<string, string> = PASSWORD
  ? { Authorization: `Basic ${btoa(`${USER}:${PASSWORD}`)}` }
  : {};

async function pgrst<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: AUTH_HEADER });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// PostgREST URL filter syntax for "between two timestamps":
// ?start_ts=gte.<from>&start_ts=lt.<to>
// URLSearchParams collapses duplicate keys, so build manually.
export function fetchEvents(
  fromIso: string,
  toIso: string,
): Promise<DashboardEvent[]> {
  const url =
    `/events` +
    `?start_ts=gte.${encodeURIComponent(fromIso)}` +
    `&start_ts=lt.${encodeURIComponent(toIso)}` +
    `&order=start_ts.asc` +
    `&limit=20000`;
  return pgrst<DashboardEvent[]>(url);
}

export function fetchReports(limit = 50): Promise<Report[]> {
  return pgrst<Report[]>(
    `/reports?deleted_at=is.null&order=created_at.desc&limit=${limit}`,
  );
}

export function fetchHealth(): Promise<{ ok: boolean; count: number }> {
  // PostgREST returns Content-Range in headers; for a simple "alive?"
  // check we just verify a HEAD-style request returns 200 by counting
  // a single row.
  return pgrst<DashboardEvent[]>('/events?limit=1').then((rows) => ({
    ok: true,
    count: rows.length,
  }));
}

export type DeviceLastSeen = {
  device: string;
  start_ts: string;     // most recent observation time
  received_at: string;  // most recent server-receive time
};

// Place visits whose span overlaps the [fromIso, toIso) window.
// Overlap (not start_ts-in-window) is what we want: a visit that
// started yesterday at 23:35 and continues through today still
// belongs in today's view. PostgREST: span overlaps iff
// `start_ts < to` AND `end_ts > from`.
export function fetchPlaceVisits(
  fromIso: string,
  toIso: string,
): Promise<PlaceVisit[]> {
  const url =
    `/v_place_visit_today` +
    `?start_ts=lt.${encodeURIComponent(toIso)}` +
    `&end_ts=gt.${encodeURIComponent(fromIso)}` +
    `&order=start_ts.asc`;
  return pgrst<Array<Omit<PlaceVisit, 'kind'>>>(url).then((rows) =>
    rows.map((r) => ({ ...r, kind: 'place_visit' as const })),
  );
}

// Sleep rows whose `wake_local_date` matches one of the supplied
// YYYY-MM-DD strings. /today queries this for the displayed day's
// wake (= day_start) and the next day's wake (= day_end). Returns
// rows or an empty array when no sleep was confidently detected.
export function fetchSleepByWakeDates(dates: string[]): Promise<Sleep[]> {
  if (dates.length === 0) return Promise.resolve([]);
  const list = dates.join(',');
  // PostgREST jsonb path filter: data->>wake_local_date=in.(d1,d2)
  const url =
    `/v_sleep_today` +
    `?data->>wake_local_date=in.(${encodeURIComponent(list)})` +
    `&order=end_ts.asc`;
  return pgrst<Array<Omit<Sleep, 'kind'>>>(url).then((rows) =>
    rows.map((r) => ({ ...r, kind: 'sleep' as const })),
  );
}

// Travel legs whose span overlaps the window. Same overlap logic as
// place visits.
export function fetchTravelLegs(
  fromIso: string,
  toIso: string,
): Promise<TravelLeg[]> {
  const url =
    `/v_travel_leg_today` +
    `?start_ts=lt.${encodeURIComponent(toIso)}` +
    `&end_ts=gt.${encodeURIComponent(fromIso)}` +
    `&order=start_ts.asc`;
  return pgrst<Array<Omit<TravelLeg, 'kind'>>>(url).then((rows) =>
    rows.map((r) => ({ ...r, kind: 'travel_leg' as const })),
  );
}

// Latest event per device — pulled from the most-recent 200 rows
// regardless of the picked viz window. Used by the Raw page header
// to show "is each device still alive?"
export async function fetchDeviceLastSeen(): Promise<DeviceLastSeen[]> {
  const rows = await pgrst<DeviceLastSeen[]>(
    '/events?select=device,start_ts,received_at&order=received_at.desc&limit=200',
  );
  const seen: Record<string, DeviceLastSeen> = {};
  for (const r of rows) {
    if (!seen[r.device]) seen[r.device] = r;
  }
  return Object.values(seen).sort((a, b) => a.device.localeCompare(b.device));
}
