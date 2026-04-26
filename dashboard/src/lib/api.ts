import type { BlocksResponse, Report, Summary } from './types';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

export function fetchReports(limit = 50) {
  return get<Report[]>(`/api/reports?limit=${limit}`);
}

export function fetchBlocks(fromIso: string, toIso: string, hideSources: string[] = []) {
  const params = new URLSearchParams({ from: fromIso, to: toIso });
  if (hideSources.length) params.set('hide', hideSources.join(','));
  return get<BlocksResponse>(`/api/blocks?${params.toString()}`);
}

export function fetchHealth() {
  return get<{ ok: true; now: string }>(`/api/health`);
}

export function fetchSummary(fromIso: string, toIso: string) {
  const params = new URLSearchParams({ from: fromIso, to: toIso });
  return get<Summary>(`/api/summary?${params.toString()}`);
}
