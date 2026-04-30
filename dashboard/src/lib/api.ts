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
  TopicChunk,
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

// Project/topic chunks whose span overlaps the window. The view
// (v_project_chunk_today) returns id, start_ts, end_ts, parent_id,
// topic, plus a `data` JSONB with category. Flatten category up to
// the row and tag kind client-side to match the TopicChunk shape.
type ProjectChunkRow = {
  id: string;
  start_ts: string;
  end_ts: string;
  parent_id: string | null;
  topic: string;
  data: {
    category: 'work' | 'play' | 'neutral';
    device?: 'mac' | 'phone';
    project_slug?: string | null;
    title?: string | null;
    app?: string | null;
  };
  // Phase-B view (0015) lifts a slim project object to the row top
  // level: `{slug, name}` or NULL. Optional in the type because the
  // dashboard ships before the migration is guaranteed to land in
  // every environment.
  project?: { slug: string; name: string } | null;
};

function mapChunkRow(r: ProjectChunkRow): TopicChunk {
  return {
    kind: 'topic_chunk' as const,
    id: r.id,
    parent_id: r.parent_id ?? '',
    start_ts: r.start_ts,
    end_ts: r.end_ts,
    topic: r.topic,
    category: r.data.category,
    device: r.data.device,
    // Pre-Phase-B rows had `'personal'` as a project slug. Post-Phase-B
    // those are NULL. Either way, treat null/empty/'personal' as "no
    // project" — the dashboard's drill auto-skip simplifies to checking
    // `c.project != null`.
    project: r.project?.slug ?? r.data.project_slug ?? null,
    project_name: r.project?.name ?? null,
    title: r.data.title || r.data.app || r.topic,
  };
}

// Day-window fetcher — kept for any caller that needs all chunks
// at once (e.g. a future /summary aggregate path that streams). The
// /today page does NOT use this anymore: it fetches chunks per-span
// on selection via fetchProjectChunksForSpan below.
export function fetchProjectChunks(
  fromIso: string,
  toIso: string,
): Promise<TopicChunk[]> {
  const url =
    `/v_project_chunk_today` +
    `?start_ts=lt.${encodeURIComponent(toIso)}` +
    `&end_ts=gt.${encodeURIComponent(fromIso)}` +
    `&order=start_ts.asc`;
  return pgrst<ProjectChunkRow[]>(url).then((rows) => rows.map(mapChunkRow));
}

// Per-span fetcher — called when the user selects a visit/leg. Queries
// chunks whose start_ts falls within the span's [start, end). Uses the
// existing (source, start_ts) index → ~1ms regardless of corpus size.
//
// PRIOR APPROACH was `?parent_id=eq.<uuid>`, but the view's parent_id
// is a LATERAL-computed field — filtering by it required computing
// parent_id for every chunk first, costing O(N) per query as the
// corpus grew. Time-window queries against the indexed start_ts are
// trivially indexable. The view's parent_id LATERAL is going away.
export function fetchProjectChunksForSpan(
  startIso: string,
  endIso: string,
): Promise<TopicChunk[]> {
  const url =
    `/v_project_chunk_today` +
    `?start_ts=gte.${encodeURIComponent(startIso)}` +
    `&start_ts=lt.${encodeURIComponent(endIso)}` +
    `&order=start_ts.asc`;
  return pgrst<ProjectChunkRow[]>(url).then((rows) => rows.map(mapChunkRow));
}

// User-curated projects table. Slug is the stable key the classifier
// returns and that lives on every TopicChunk; `name` is the
// human-friendly label the dashboard renders. Archived projects stay
// in the table so historical chunks still resolve to a name.
export type Project = {
  slug: string;
  name: string;
  description: string | null;
  archived_at: string | null;
};

export function fetchProjects(): Promise<Project[]> {
  return pgrst<Project[]>(
    '/projects?select=slug,name,description,archived_at&order=slug.asc',
  );
}

// Place metadata side-channel. The `v_place_visit_today` view exposes
// `name + category + centroid` only — but unnamed OSM polygons land in
// the table with names like `building:7088849`, and the only way to
// produce a friendly fallback ("Unnamed dormitory") is to read
// `metadata->mapbox->type`. Fetched once per session; cached forever.
export type PlaceMeta = {
  name: string;
  metadata: { mapbox?: Record<string, unknown> } | null;
};

export function fetchUnnamedPlaceMeta(): Promise<PlaceMeta[]> {
  // Only the placeholder-named rows need a fallback. PostgREST `like`
  // uses `*` as the wildcard. The `:` separator (between layer and
  // OSM id) is a plain literal — no escaping needed. Three layer
  // prefixes cover every fallback name produced by `_fallback_name`
  // in places_repo.py.
  const url =
    `/places` +
    `?select=name,metadata` +
    `&or=(name.like.building:*,name.like.landuse:*,name.like.poi_label:*)`;
  return pgrst<PlaceMeta[]>(url);
}

// =====================================================================
// /summary + /trends fetchers
// =====================================================================
//
// Both pages read from per-day aggregate views computed on-read in
// migration 0017. Wire payload is small (one row per local-date),
// so we fetch a window via PostgREST `local_date=gte.X&local_date=lt.Y`.
//
// "Local date" is America/Chicago — same TZ the views hardcode and the
// sleep deriver uses. When that becomes settings-driven, the dashboard
// follows.

// Per-day summary row. All `_s` fields are SECONDS. Multiply by 1000
// when handing to the donut (which expects ms).
export type DailySummary = {
  local_date: string;            // 'YYYY-MM-DD'
  awake_s: number;
  mac_active_s: number;
  phone_active_s: number;
  phone_effective_s: number;     // mac-precedence applied
  work_effective_s: number;
  play_effective_s: number;
  neutral_effective_s: number;
  free_s: number;                // awake − (work + neutral); play counts as free
  sleep_main_s: number;
  sleep_disrupted_count: number;
  place_visit_count: number;
  distinct_places: number;
  travel_distance_m: number;
  first_active_ts: string | null;
  last_active_ts: string | null;
};

// Per-(day, project) row from v_project_activity.
export type ProjectActivity = {
  local_date: string;
  project_slug: string;
  project_name: string | null;   // null when slug is unknown to projects table
  total_s: number;               // mac-precedence applied
  chunk_count: number;
};

// Fetch daily summary rows whose local_date is in [fromDate, toDate].
// fromDate / toDate are 'YYYY-MM-DD' strings. Inclusive on both ends so
// a single-day fetch passes the same string for both.
export function fetchDailySummary(
  fromDate: string,
  toDate: string,
): Promise<DailySummary[]> {
  const url =
    `/v_daily_summary` +
    `?local_date=gte.${encodeURIComponent(fromDate)}` +
    `&local_date=lte.${encodeURIComponent(toDate)}` +
    `&order=local_date.asc`;
  return pgrst<DailySummary[]>(url);
}

export function fetchProjectActivity(
  fromDate: string,
  toDate: string,
): Promise<ProjectActivity[]> {
  const url =
    `/v_project_activity` +
    `?local_date=gte.${encodeURIComponent(fromDate)}` +
    `&local_date=lte.${encodeURIComponent(toDate)}` +
    `&order=local_date.asc,total_s.desc`;
  return pgrst<ProjectActivity[]>(url);
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
