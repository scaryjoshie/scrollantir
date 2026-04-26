// Event → block coalescing. Lives next to summarize so the server/ module
// owns all event-shape business logic, keeping src/ focused on UI.

import type { EventRow } from './types';

export type Block = {
  id: string;
  device: 'mac' | 'phone';
  source: string;
  start_ms: number;
  end_ms: number;
  label: string;
  app: string | null;
  title: string | null;
  url: string | null;
  merged: number;
  tags: string[];
};

const GAP_TOLERANCE_MS = 30_000;
const MIN_DURATION_MS = 800;

// Sources where short durations mean "tab-switch flicker" rather than real
// use. Drop events below this threshold entirely. Raw events stay in the DB;
// this is a visualization choice only.
const FLICKER_SOURCES = new Set(['system.window', 'zen.tab']);
const FLICKER_THRESHOLD_S = 2;

export function buildBlocks(events: EventRow[]): Block[] {
  if (events.length === 0) return [];

  const out: Block[] = [];
  let current: { block: Block; key: string } | null = null;

  for (const ev of events) {
    if (FLICKER_SOURCES.has(ev.source) && ev.duration_s < FLICKER_THRESHOLD_S) {
      continue;
    }

    // Filter AFK status noise: "not-afk" rows are active, not AFK. Keeping
    // the "afk" spans lets the timeline still show AW's away periods.
    if (ev.source === 'system.afk') {
      const status = (ev.data ?? {})['status'];
      if (status !== 'afk') continue;
    }

    const start = Date.parse(ev.timestamp_utc);
    const end = start + Math.max(ev.duration_s * 1000, MIN_DURATION_MS);
    const data = ev.data ?? {};
    const app = pickStr(data, 'app');
    const title = pickStr(data, 'title');
    const url = pickStr(data, 'url');
    const key = coalesceKey(ev.source, app, title, url);

    if (
      current &&
      current.block.device === ev.device &&
      current.block.source === ev.source &&
      current.key === key &&
      start - current.block.end_ms <= GAP_TOLERANCE_MS
    ) {
      current.block.end_ms = Math.max(current.block.end_ms, end);
      current.block.merged += 1;
      if (title) current.block.title = title;
      if (url) current.block.url = url;
      continue;
    }

    if (current) out.push(current.block);
    const block: Block = {
      id: ev.id,
      device: ev.device,
      source: ev.source,
      start_ms: start,
      end_ms: end,
      label: app ?? title ?? ev.source,
      app,
      title,
      url,
      merged: 1,
      tags: ev.tags,
    };
    current = { block, key };
  }
  if (current) out.push(current.block);

  out.sort((a, b) => a.start_ms - b.start_ms);
  return out;
}

function coalesceKey(
  source: string,
  app: string | null,
  title: string | null,
  url: string | null,
): string {
  if (app) return `app:${app}`;
  if (source === 'zen.tab' && url) return `host:${hostOf(url)}`;
  if (title) return `title:${title}`;
  return `source:${source}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pickStr(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}
