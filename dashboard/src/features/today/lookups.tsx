// Today-page runtime lookups (visits + legs + chunks by id), provided
// by Today.tsx and consumed by MapPane / DetailPane / Timeline.
//
// Replaces the previous direct `import { visitById } from './fixtures'`
// pattern — the panes now read whatever data is currently fetched
// rather than the hand-shaped demo. Topic chunks aren't a derived
// kind in v0 so the default is an empty list; once a topic_chunk
// deriver ships (or render-side composition lands), populate it
// here without touching the consumers.

import { createContext, useContext, useMemo } from 'react';
import type { PlaceVisit, TopicChunk, TravelLeg } from './types';

export type TodayLookups = {
  visitById: Record<string, PlaceVisit>;
  legById: Record<string, TravelLeg>;
  topicChunks: TopicChunk[];
};

const EMPTY: TodayLookups = {
  visitById: {},
  legById: {},
  topicChunks: [],
};

const TodayLookupsContext = createContext<TodayLookups>(EMPTY);

export const TodayLookupsProvider = TodayLookupsContext.Provider;

export function useTodayLookups(): TodayLookups {
  return useContext(TodayLookupsContext);
}

// Helper for the host page: build the lookups from fetched arrays
// once per fetch result. Memoize on the input arrays.
export function useBuildLookups(
  visits: PlaceVisit[] | undefined,
  legs: TravelLeg[] | undefined,
  chunks: TopicChunk[] = [],
): TodayLookups {
  return useMemo(() => {
    return {
      visitById: Object.fromEntries((visits ?? []).map((v) => [v.id, v])),
      legById: Object.fromEntries((legs ?? []).map((l) => [l.id, l])),
      topicChunks: chunks,
    };
  }, [visits, legs, chunks]);
}
