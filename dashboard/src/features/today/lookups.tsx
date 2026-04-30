// Today-page runtime lookups (visits + legs by id), provided by
// Today.tsx and consumed by MapPane / DetailPane / Timeline.
//
// project_chunks are NO LONGER passed through here — DetailPane
// fetches them lazily per-parent on selection (api.ts
// fetchProjectChunksForParent). That dropped ~10KB of compressed
// wire traffic on every /today load.

import { createContext, useContext, useMemo } from 'react';
import type { PlaceVisit, TravelLeg } from './types';

export type TodayLookups = {
  visitById: Record<string, PlaceVisit>;
  legById: Record<string, TravelLeg>;
};

const EMPTY: TodayLookups = {
  visitById: {},
  legById: {},
};

const TodayLookupsContext = createContext<TodayLookups>(EMPTY);

export const TodayLookupsProvider = TodayLookupsContext.Provider;

export function useTodayLookups(): TodayLookups {
  return useContext(TodayLookupsContext);
}

export function useBuildLookups(
  visits: PlaceVisit[] | undefined,
  legs: TravelLeg[] | undefined,
): TodayLookups {
  return useMemo(() => {
    return {
      visitById: Object.fromEntries((visits ?? []).map((v) => [v.id, v])),
      legById: Object.fromEntries((legs ?? []).map((l) => [l.id, l])),
    };
  }, [visits, legs]);
}
