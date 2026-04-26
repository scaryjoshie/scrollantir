import type { Block } from '@/lib/types';

export type BlocksByDevice = {
  mac: Block[];
  phone: Block[];
};

export function groupByDevice(blocks: Block[]): BlocksByDevice {
  const mac: Block[] = [];
  const phone: Block[] = [];
  for (const b of blocks) {
    if (b.device === 'mac') mac.push(b);
    else if (b.device === 'phone') phone.push(b);
  }
  // buildBlocks already sorts globally; sort again defensively.
  mac.sort((a, b) => a.start_ms - b.start_ms);
  phone.sort((a, b) => a.start_ms - b.start_ms);
  return { mac, phone };
}

// Return the block covering `timeMs`, if any. Binary search on start_ms; we
// then scan backwards to find any earlier block whose end_ms covers t (blocks
// can overlap across sub-lanes of the same device).
export function blockAt(sortedBlocks: Block[], timeMs: number): Block | null {
  if (sortedBlocks.length === 0) return null;

  // Find right-most block whose start_ms <= t.
  let lo = 0;
  let hi = sortedBlocks.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedBlocks[mid].start_ms <= timeMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return null;

  // Scan a short window back to catch overlaps — cheap and bounded.
  for (let i = idx; i >= Math.max(0, idx - 20); i--) {
    const b = sortedBlocks[i];
    if (b.start_ms <= timeMs && timeMs < b.end_ms) return b;
  }
  return null;
}
