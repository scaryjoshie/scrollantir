// Pure interval arithmetic on [start, end) ranges of epoch-ms.
// No side effects; safe to hoist to a shared package later.

export type Span = { start: number; end: number };

export function union(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];
  const out: Span[] = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

export function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i].start, b[j].start);
    const e = Math.min(a[i].end, b[j].end);
    if (s < e) out.push({ start: s, end: e });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

export function subtract(a: Span[], b: Span[]): Span[] {
  if (b.length === 0) return a.map((s) => ({ ...s }));
  const out: Span[] = [];
  for (const span of a) {
    let curStart = span.start;
    const curEnd = span.end;
    for (const x of b) {
      if (x.end <= curStart) continue;
      if (x.start >= curEnd) break;
      if (x.start > curStart) out.push({ start: curStart, end: Math.min(x.start, curEnd) });
      curStart = Math.max(curStart, x.end);
      if (curStart >= curEnd) break;
    }
    if (curStart < curEnd) out.push({ start: curStart, end: curEnd });
  }
  return out;
}

export function clip(spans: Span[], bounds: Span): Span[] {
  return intersect(spans, [bounds]);
}

export function total(spans: Span[]): number {
  let acc = 0;
  for (const s of spans) acc += s.end - s.start;
  return acc;
}
