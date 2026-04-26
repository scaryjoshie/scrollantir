// Central summarization logic. Pure function of events + window; no DB or
// HTTP. Designed to be lifted into a shared package (or the orchestrator)
// once a second caller exists.
//
// Current model:
//
//   mac_focus     := union(event spans where device=mac and source in FOCUS)
//   phone_active  := union(event spans where device=phone, source=system.foreground)
//   derived_idle  := gaps in (mac_focus ∪ phone_active) within window,
//                    lasting ≥ 2 min                   (see idle.ts)
//   mac_active    := mac_focus
//   concurrent    := mac_active ∩ phone_active        — both in use
//   mac_only      := mac_active − phone_active        — attention only on Mac
//   phone_only    := phone_active − mac_active        — attention only on Phone
//
// Why mac_active = mac_focus (no AFK subtraction):
//   AW's aw-watcher-afk is wildly over-aggressive (counted ~10h idle against
//   ~11h focus on a normal day). We replaced it with a derived-idle model
//   computed from gaps in activity coverage — see server/idle.ts. AW's raw
//   system.afk reading is still surfaced in mac_afk_ms for comparison.
//
// Caveats:
//   - Per-app shares are computed against the per-device active total.
//   - Lock-screen (loginwindow / SecurityAgent) apps are excluded entirely,
//     so time-spent-locked isn't credited to "on Mac".
//   - A tighter model would subtract screensaver / lock spans if the Mac
//     collector starts emitting them as explicit events.

import type { EventRow } from './types';
import * as S from './spans';
import { EXCLUDED_MAC_APPS, labelForApp } from './labels';
import { deriveIdle, DEFAULT_IDLE_THRESHOLD_MS } from './idle';

export type AppTime = { app: string; ms: number; share: number };

export type Summary = {
  window: { start: number; end: number };
  mac_active_ms: number;
  mac_focus_ms: number;
  mac_afk_ms: number;            // AW's raw reading, surfaced for comparison
  derived_idle_ms: number;       // our own idle model (see idle.ts)
  derived_idle_threshold_ms: number;
  phone_active_ms: number;
  concurrent_ms: number;
  mac_only_ms: number;
  phone_only_ms: number;
  events_total: number;
  top_mac_apps: AppTime[];
  top_phone_apps: AppTime[];
};

// system.window already captures "Zen was focused"; zen.tab is *tab-level*
// detail inside that span. We keep it for labeling/color in the timeline but
// do NOT include it here — it double-counts, and Zen's extension emits
// orphan zen.tab events while other apps are focused.
const MAC_FOCUS_SOURCES = new Set(['system.window']);
const PHONE_ACTIVE_SOURCES = new Set(['system.foreground']);

// AW emits system.afk with data.status ∈ {"afk", "not-afk"}. Only afk rows
// represent actual away-from-keyboard spans.
const AFK_STATUS_AWAY = 'afk';

const MIN_SPAN_MS = 800;
const TOP_N = 8;

export function summarize(
  events: EventRow[],
  windowStart: number,
  windowEnd: number,
): Summary {
  const bounds: S.Span = { start: windowStart, end: windowEnd };

  const macFocusRaw: S.Span[] = [];
  const macAfkRaw: S.Span[] = [];
  const phoneActiveRaw: S.Span[] = [];
  const macAppSpans = new Map<string, S.Span[]>();
  const phoneAppSpans = new Map<string, S.Span[]>();

  for (const ev of events) {
    // Drop very-short focus/foreground events. They're tab-transition flickers
    // with no meaningful dwell time (62% of Zen events and 38% of cmux events
    // fall below this threshold on a normal day). Raw events are still in the
    // DB; this is a modeling choice for summaries + timeline.
    const FLICKER_THRESHOLD_S = 2;
    const isFocusLike =
      (ev.device === 'mac' && MAC_FOCUS_SOURCES.has(ev.source)) ||
      (ev.device === 'phone' && PHONE_ACTIVE_SOURCES.has(ev.source));
    if (isFocusLike && ev.duration_s < FLICKER_THRESHOLD_S) continue;

    const start = Date.parse(ev.timestamp_utc);
    const rawEnd = start + Math.max(ev.duration_s * 1000, MIN_SPAN_MS);
    const span = clipInclusive(start, rawEnd, windowStart, windowEnd);
    if (!span) continue;

    const app = pickStr(ev.data, 'app');

    if (ev.device === 'mac') {
      if (MAC_FOCUS_SOURCES.has(ev.source)) {
        // Don't count lock-screen / auth-prompt apps as Mac-active time.
        if (app && EXCLUDED_MAC_APPS.has(app)) continue;
        macFocusRaw.push(span);
        if (app) pushApp(macAppSpans, labelForApp('mac', app), span);
      } else if (ev.source === 'system.afk') {
        // Only `status=afk` rows are actual AFK spans. `status=not-afk` rows
        // describe active spans; counting them as AFK was inflating mac_afk_ms.
        const status = pickStr(ev.data, 'status');
        if (status === AFK_STATUS_AWAY) macAfkRaw.push(span);
      }
    } else if (ev.device === 'phone') {
      if (PHONE_ACTIVE_SOURCES.has(ev.source)) {
        phoneActiveRaw.push(span);
        if (app) pushApp(phoneAppSpans, labelForApp('phone', app), span);
      }
    }
  }

  const macFocus = S.clip(S.union(macFocusRaw), bounds);
  const macAfk = S.clip(S.union(macAfkRaw), bounds);
  const phoneActive = S.clip(S.union(phoneActiveRaw), bounds);

  // Derived idle replaces AW's AFK. See server/idle.ts. Clip the bounds to
  // "now" so we don't count the unlived future as idle — previously, asking
  // for today's summary at 11am produced ~14h idle because the 13h of future
  // had no activity yet.
  const now = Date.now();
  const effectiveEnd = Math.min(windowEnd, now);
  const idleBounds: S.Span =
    effectiveEnd > windowStart
      ? { start: windowStart, end: effectiveEnd }
      : bounds;
  const derivedIdle = deriveIdle(macFocus, phoneActive, idleBounds);

  // Mac active = raw focus coverage. Idle is, by construction, outside
  // focus, so no subtraction is needed.
  const macActive = macFocus;
  const concurrent = S.intersect(macActive, phoneActive);
  const macOnly = S.subtract(macActive, phoneActive);
  const phoneOnly = S.subtract(phoneActive, macActive);

  const macActiveMs = S.total(macActive);
  const phoneActiveMs = S.total(phoneActive);

  const topMac = topAppsClipped(macAppSpans, macActive, macActiveMs, TOP_N);
  const topPhone = topAppsClipped(phoneAppSpans, phoneActive, phoneActiveMs, TOP_N);

  return {
    window: bounds,
    mac_active_ms: macActiveMs,
    mac_focus_ms: S.total(macFocus),
    mac_afk_ms: S.total(macAfk),
    derived_idle_ms: S.total(derivedIdle),
    derived_idle_threshold_ms: DEFAULT_IDLE_THRESHOLD_MS,
    phone_active_ms: phoneActiveMs,
    concurrent_ms: S.total(concurrent),
    mac_only_ms: S.total(macOnly),
    phone_only_ms: S.total(phoneOnly),
    events_total: events.length,
    top_mac_apps: topMac,
    top_phone_apps: topPhone,
  };
}

function topAppsClipped(
  byApp: Map<string, S.Span[]>,
  activeMask: S.Span[],
  activeTotalMs: number,
  n: number,
): AppTime[] {
  const out: AppTime[] = [];
  for (const [app, spans] of byApp) {
    const ms = S.total(S.intersect(S.union(spans), activeMask));
    if (ms <= 0) continue;
    out.push({
      app,
      ms,
      share: activeTotalMs > 0 ? ms / activeTotalMs : 0,
    });
  }
  out.sort((a, b) => b.ms - a.ms);
  return out.slice(0, n);
}

function pushApp(map: Map<string, S.Span[]>, key: string, span: S.Span) {
  const list = map.get(key);
  if (list) list.push(span);
  else map.set(key, [span]);
}

function clipInclusive(
  start: number,
  end: number,
  wStart: number,
  wEnd: number,
): S.Span | null {
  const s = Math.max(start, wStart);
  const e = Math.min(end, wEnd);
  if (e <= s) return null;
  return { start: s, end: e };
}

function pickStr(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
