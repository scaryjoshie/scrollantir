export type EventRow = {
  id: string;
  device: 'mac' | 'phone';
  device_label: string | null;
  source: string;
  timestamp_utc: string;
  duration_s: number;
  data: Record<string, unknown> | null;
  tags: string[];
};
