import type { DeviceKind } from '@/lib/types';

export type LaneId =
  | 'mac.windows'
  | 'mac.tabs'
  | 'mac.afk'
  | 'mac.other'
  | 'phone.foreground'
  | 'phone.shortform'
  | 'phone.screen'
  | 'phone.unlock'
  | 'phone.detector'
  | 'phone.other'
  | 'location';

export type LaneGroup = {
  id: LaneId | 'mac' | 'phone';
  content: string;
  nestedGroups?: LaneId[];
  showNested?: boolean;
  order: number;
};

export function sublaneFor(device: DeviceKind | 'location', source: string): LaneId {
  if (device === 'mac') {
    if (source === 'system.window') return 'mac.windows';
    if (source === 'zen.tab') return 'mac.tabs';
    if (source === 'system.afk') return 'mac.afk';
    return 'mac.other';
  }
  if (device === 'phone') {
    if (source === 'system.foreground') return 'phone.foreground';
    if (source === 'system.screen') return 'phone.screen';
    if (source === 'system.unlock' || source === 'system.unlocked') return 'phone.unlock';
    if (
      source === 'youtube.shorts' ||
      source === 'instagram.reels' ||
      source === 'tiktok.feed'
    )
      return 'phone.shortform';
    if (source === 'detector.miss') return 'phone.detector';
    return 'phone.other';
  }
  return 'location';
}

export function buildGroups(opts: { showDetector: boolean }): LaneGroup[] {
  const macKids: LaneId[] = ['mac.windows', 'mac.tabs', 'mac.afk', 'mac.other'];
  const phoneKids: LaneId[] = [
    'phone.foreground',
    'phone.shortform',
    'phone.screen',
    'phone.unlock',
    ...((opts.showDetector ? ['phone.detector'] : []) as LaneId[]),
    'phone.other',
  ];

  return [
    { id: 'mac', content: 'Mac', nestedGroups: macKids, showNested: true, order: 0 },
    { id: 'mac.windows', content: 'Windows', order: 1 },
    { id: 'mac.tabs', content: 'Browser', order: 2 },
    { id: 'mac.afk', content: 'AFK', order: 3 },
    { id: 'mac.other', content: 'Other', order: 4 },

    { id: 'phone', content: 'Phone', nestedGroups: phoneKids, showNested: true, order: 10 },
    { id: 'phone.foreground', content: 'Foreground', order: 11 },
    { id: 'phone.shortform', content: 'Short-form', order: 12 },
    { id: 'phone.screen', content: 'Screen', order: 13 },
    { id: 'phone.unlock', content: 'Unlock', order: 14 },
    ...(opts.showDetector
      ? ([{ id: 'phone.detector' as const, content: 'Detector misses', order: 15 }] satisfies LaneGroup[])
      : []),
    { id: 'phone.other', content: 'Other', order: 16 },

    {
      id: 'location',
      content: 'Location <span style="opacity:.55;font-weight:400;text-transform:none;letter-spacing:normal;">· collection pending</span>',
      order: 20,
    },
  ];
}
