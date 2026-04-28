// Schema-aligned types for the runtime/ stack.

export type DashboardEvent = {
  id: string;
  source: string;       // e.g. 'phone.youtube.shorts', 'mac.system.window'
  device: string;       // generated; first dotted segment of source
  start_ts: string;     // ISO 8601 UTC
  end_ts: string;       // ISO 8601 UTC; equals start_ts for point events
  duration_s: number;   // generated; (end_ts - start_ts) in seconds
  data: Record<string, unknown>;
  received_at: string;
};

export type Report = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  window_start: string | null;
  window_end: string | null;
  created_at: string;
};
