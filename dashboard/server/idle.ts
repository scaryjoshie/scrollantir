// Derived idle model, replacing AW's aw-watcher-afk.
//
// Rule: a stretch of the day is "idle" iff no Mac focus event AND no phone
// foreground event covers it, and the stretch is at least minGapMs long.
//
// Why this works:
//   - Focus events carry real duration_s. A 30-min YouTube watch emits one
//     zen.tab event with duration ≈ 1800s — it covers the span, so it's not
//     idle. Same for an 85-min Xcode session (a single system.window event
//     with duration ≈ 5100s).
//   - Phone activity outside Mac focus (e.g. on the couch) is not idle;
//     that's "on phone, mac asleep." Both devices have to be silent.
//   - Retroactive start is automatic — the silence span begins at the end
//     of the prior activity, not when the threshold trips. The threshold
//     just filters which gaps count as real idle.
//
// AW's raw system.afk events stay in the DB (immutable). We simply don't
// consult them for the active-time computation. They remain readable for
// debugging or comparison.

import type { Span } from './spans';
import * as S from './spans';

export const DEFAULT_IDLE_THRESHOLD_MS = 2 * 60 * 1000;

export function deriveIdle(
  macFocus: Span[],
  phoneActive: Span[],
  windowBounds: Span,
  minGapMs: number = DEFAULT_IDLE_THRESHOLD_MS,
): Span[] {
  const activity = S.union([...macFocus, ...phoneActive]);
  const gaps = S.subtract([windowBounds], activity);
  return gaps.filter((g) => g.end - g.start >= minGapMs);
}
