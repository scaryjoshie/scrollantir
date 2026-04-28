import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict, parseISO, differenceInSeconds } from 'date-fns';
import { fetchDeviceLastSeen, type DeviceLastSeen } from '@/lib/api';
import { cn } from '@/lib/cn';

// Staleness thresholds (seconds since last received_at).
// Mac forwarder ticks every 30s; phone forwards every 15min.
// Different floors per device, so the green/yellow/red bands need
// to be relative.
const STALENESS = {
  mac: { green: 60, yellow: 5 * 60, red: 30 * 60 },
  phone: { green: 20 * 60, yellow: 60 * 60, red: 4 * 60 * 60 },
  // synthetic devices (cloud, prompt) — no expected cadence
  default: { green: 60 * 60, yellow: 6 * 60 * 60, red: 24 * 60 * 60 },
} as const;

function staleness(device: string, secondsAgo: number): 'green' | 'yellow' | 'red' {
  const t =
    device in STALENESS
      ? STALENESS[device as keyof typeof STALENESS]
      : STALENESS.default;
  if (secondsAgo <= t.green) return 'green';
  if (secondsAgo <= t.yellow) return 'yellow';
  return 'red';
}

export default function DeviceLastSeenBadges() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['device-last-seen'],
    queryFn: fetchDeviceLastSeen,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (isLoading || error || !data || data.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      {data.map((d) => (
        <Badge key={d.device} d={d} />
      ))}
    </div>
  );
}

function Badge({ d }: { d: DeviceLastSeen }) {
  const secondsAgo = differenceInSeconds(new Date(), parseISO(d.received_at));
  const tier = staleness(d.device, secondsAgo);
  const ago = formatDistanceToNowStrict(parseISO(d.received_at), { addSuffix: false });

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
        tier === 'green' && 'bg-success-soft text-success',
        tier === 'yellow' && 'bg-warning-soft text-warning',
        tier === 'red' && 'bg-danger-soft text-danger',
      )}
      title={`Last received: ${d.received_at}`}
    >
      <span
        className={cn(
          'inline-block w-1.5 h-1.5 rounded-full',
          tier === 'green' && 'bg-success',
          tier === 'yellow' && 'bg-warning',
          tier === 'red' && 'bg-danger',
        )}
      />
      <span className="font-mono">{d.device}</span>
      <span className="text-ink-subtle font-normal">{ago}</span>
    </div>
  );
}
