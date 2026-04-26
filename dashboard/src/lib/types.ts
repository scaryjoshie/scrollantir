// Type-only re-exports from server/. No runtime cost in the client bundle —
// `import type` is erased by TypeScript.

export type { Block } from '../../server/blocks';
export type { Summary, AppTime } from '../../server/summarize';

export type Report = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  window_start: string | null;
  window_end: string | null;
  created_at: string;
};

export type DeviceKind = 'mac' | 'phone';

export type BlocksResponse = {
  blocks: import('../../server/blocks').Block[];
  stats: {
    events_total: number;
    events_kept: number;
    blocks: number;
  };
};
