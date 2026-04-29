// Static-mock day for the /today page. One Wednesday at Northwestern
// (Evanston campus) with realistic place coords and plausible
// per-visit topic chunks. Times span dawn → day → dusk → night so the
// map's lighting preset transitions are all visible as you click
// through the timeline.
//
// Replace with real fetchers once these views/derivers ship:
//   - place_visit/v1   (deriver, runtime/app/src/scrollantir/core/)
//   - travel_leg/v1    (deriver, same)
//   - topic chunks     (heuristic rule pyramid → SQL view; LLM
//                       session_summary/v1 overrides later)
//   - sleep/v1.end_ts  (deriver, surfaces as the morning Moment)

import type {
  Moment,
  PlaceVisit,
  TimelineEntry,
  TopicChunk,
  TravelLeg,
} from './types';

// 2026-04-29 (Wednesday). Offsets CDT (-05:00).
// The "day" runs 04:00 → 04:00 next morning (so a late-night Discord
// call past midnight still belongs to Wednesday's view). Late-night
// chunks past midnight use tNext().
const D = '2026-04-29';
const D_NEXT = '2026-04-30';
const Z = '-05:00';
const t = (hhmm: string): string => `${D}T${hhmm}:00${Z}`;
const tNext = (hhmm: string): string => `${D_NEXT}T${hhmm}:00${Z}`;

// Northwestern Evanston landmark coords [lng, lat] (Mapbox order).
const SARGENT: [number, number] = [-87.6747, 42.0571];   // residence
const TECH: [number, number] = [-87.6753, 42.0581];      // CS / Tech Institute
const NORRIS: [number, number] = [-87.6745, 42.0531];    // student union
const MUDD: [number, number] = [-87.6743, 42.0588];      // science library
const LIBRARY: [number, number] = [-87.6753, 42.0537];   // University Library
const LAKEFILL: [number, number] = [-87.6720, 42.0545];  // lakeside path

const PLACES = {
  sargent:  { id: 'place-sargent',  name: 'Sargent Hall',          category: 'residence' as const },
  tech:     { id: 'place-tech',     name: 'Tech Institute',        category: 'class' as const },
  norris:   { id: 'place-norris',   name: 'Norris Center',         category: 'food' as const },
  mudd:     { id: 'place-mudd',     name: 'Mudd Library',          category: 'study' as const },
  library:  { id: 'place-library',  name: 'University Library',    category: 'study' as const },
  lakefill: { id: 'place-lakefill', name: 'Lakefill',              category: 'mixed' as const },
};

function walkPath(
  from: [number, number],
  to: [number, number],
  steps = 6,
  jitter = 0.0002,
): Array<[number, number]> {
  const path: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const r = i / steps;
    const lng = from[0] + (to[0] - from[0]) * r;
    const lat = from[1] + (to[1] - from[1]) * r;
    const wiggle = Math.sin(r * Math.PI) * jitter;
    path.push([lng + wiggle, lat - wiggle * 0.5]);
  }
  return path;
}

// ---------------------------------------------------------------------
// Place visits
// ---------------------------------------------------------------------

const visit_home_morning: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-home-morning',
  source: 'place_visit/v1',
  start_ts: t('06:50'),
  end_ts: t('08:15'),
  data: {
    place_id: PLACES.sargent.id,
    lat: SARGENT[1],
    lng: SARGENT[0],
    brief_exit_count: 0,
  },
  place: PLACES.sargent,
};

const visit_tech: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-tech',
  source: 'place_visit/v1',
  start_ts: t('08:25'),
  end_ts: t('09:55'),
  data: {
    place_id: PLACES.tech.id,
    lat: TECH[1],
    lng: TECH[0],
    brief_exit_count: 0,
  },
  place: PLACES.tech,
};

const visit_norris_breakfast: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-norris-am',
  source: 'place_visit/v1',
  start_ts: t('10:05'),
  end_ts: t('11:20'),
  data: {
    place_id: PLACES.norris.id,
    lat: NORRIS[1],
    lng: NORRIS[0],
    brief_exit_count: 1,
  },
  place: PLACES.norris,
};

const visit_mudd: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-mudd',
  source: 'place_visit/v1',
  start_ts: t('11:30'),
  end_ts: t('13:00'),
  data: {
    place_id: PLACES.mudd.id,
    lat: MUDD[1],
    lng: MUDD[0],
    brief_exit_count: 0,
  },
  place: PLACES.mudd,
};

const visit_norris_lunch: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-norris-pm',
  source: 'place_visit/v1',
  start_ts: t('13:10'),
  end_ts: t('13:50'),
  data: {
    place_id: PLACES.norris.id,
    lat: NORRIS[1],
    lng: NORRIS[0],
    brief_exit_count: 0,
  },
  place: PLACES.norris,
};

const visit_library: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-library',
  source: 'place_visit/v1',
  start_ts: t('14:00'),
  end_ts: t('17:00'),
  data: {
    place_id: PLACES.library.id,
    lat: LIBRARY[1],
    lng: LIBRARY[0],
    brief_exit_count: 2,
  },
  place: PLACES.library,
};

const visit_lakefill: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-lakefill',
  source: 'place_visit/v1',
  start_ts: t('17:15'),
  end_ts: t('18:00'),
  data: {
    place_id: PLACES.lakefill.id,
    lat: LAKEFILL[1],
    lng: LAKEFILL[0],
    brief_exit_count: 0,
  },
  place: PLACES.lakefill,
};

const visit_home_evening: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-home-evening',
  source: 'place_visit/v1',
  start_ts: t('18:15'),
  end_ts: t('19:50'),
  data: {
    place_id: PLACES.sargent.id,
    lat: SARGENT[1],
    lng: SARGENT[0],
    brief_exit_count: 0,
  },
  place: PLACES.sargent,
};

const visit_norris_eve: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-norris-eve',
  source: 'place_visit/v1',
  start_ts: t('20:00'),
  end_ts: t('22:50'),
  data: {
    place_id: PLACES.norris.id,
    lat: NORRIS[1],
    lng: NORRIS[0],
    brief_exit_count: 0,
  },
  place: PLACES.norris,
};

const visit_home_late: PlaceVisit = {
  kind: 'place_visit',
  id: 'visit-home-late',
  source: 'place_visit/v1',
  start_ts: t('23:00'),
  end_ts: tNext('00:45'),
  data: {
    place_id: PLACES.sargent.id,
    lat: SARGENT[1],
    lng: SARGENT[0],
    brief_exit_count: 0,
  },
  place: PLACES.sargent,
};

// ---------------------------------------------------------------------
// Travel legs
// ---------------------------------------------------------------------

const leg_home_to_tech: TravelLeg = {
  kind: 'travel_leg',
  id: 'leg-home-tech',
  source: 'travel_leg/v1',
  start_ts: t('08:15'),
  end_ts: t('08:25'),
  data: {
    from_visit_id: visit_home_morning.id,
    to_visit_id: visit_tech.id,
    dominant_activity: 'walking',
    distance_m: 130,
    reading_count: 6,
  },
  path: walkPath(SARGENT, TECH, 6),
};

const leg_tech_to_norris_am: TravelLeg = {
  kind: 'travel_leg',
  id: 'leg-tech-norris-am',
  source: 'travel_leg/v1',
  start_ts: t('09:55'),
  end_ts: t('10:05'),
  data: {
    from_visit_id: visit_tech.id,
    to_visit_id: visit_norris_breakfast.id,
    dominant_activity: 'walking',
    distance_m: 580,
    reading_count: 12,
  },
  path: walkPath(TECH, NORRIS, 10),
};

const leg_norris_am_to_mudd: TravelLeg = {
  kind: 'travel_leg',
  id: 'leg-norris-am-mudd',
  source: 'travel_leg/v1',
  start_ts: t('11:20'),
  end_ts: t('11:30'),
  data: {
    from_visit_id: visit_norris_breakfast.id,
    to_visit_id: visit_mudd.id,
    dominant_activity: 'on_bicycle',
    distance_m: 640,
    reading_count: 13,
  },
  path: walkPath(NORRIS, MUDD, 11),
};

const leg_mudd_to_norris_pm: TravelLeg = {
  kind: 'travel_leg',
  id: 'leg-mudd-norris-pm',
  source: 'travel_leg/v1',
  start_ts: t('13:00'),
  end_ts: t('13:10'),
  data: {
    from_visit_id: visit_mudd.id,
    to_visit_id: visit_norris_lunch.id,
    dominant_activity: 'walking',
    distance_m: 640,
    reading_count: 12,
  },
  path: walkPath(MUDD, NORRIS, 11),
};

const leg_norris_pm_to_library: TravelLeg = {
  kind: 'travel_leg',
  id: 'leg-norris-pm-library',
  source: 'travel_leg/v1',
  start_ts: t('13:50'),
  end_ts: t('14:00'),
  data: {
    from_visit_id: visit_norris_lunch.id,
    to_visit_id: visit_library.id,
    dominant_activity: 'walking',
    distance_m: 80,
    reading_count: 4,
  },
  path: walkPath(NORRIS, LIBRARY, 5),
};

const leg_library_to_lakefill: TravelLeg = {
  kind: 'travel_leg',
  id: 'leg-library-lakefill',
  source: 'travel_leg/v1',
  start_ts: t('17:00'),
  end_ts: t('17:15'),
  data: {
    from_visit_id: visit_library.id,
    to_visit_id: visit_lakefill.id,
    dominant_activity: 'walking',
    distance_m: 290,
    reading_count: 9,
  },
  path: walkPath(LIBRARY, LAKEFILL, 8),
};

const leg_lakefill_to_home: TravelLeg = {
  kind: 'travel_leg',
  id: 'leg-lakefill-home',
  source: 'travel_leg/v1',
  start_ts: t('18:00'),
  end_ts: t('18:15'),
  data: {
    from_visit_id: visit_lakefill.id,
    to_visit_id: visit_home_evening.id,
    dominant_activity: 'walking',
    distance_m: 380,
    reading_count: 10,
  },
  path: walkPath(LAKEFILL, SARGENT, 9),
};

const leg_home_eve_to_norris: TravelLeg = {
  kind: 'travel_leg',
  id: 'leg-home-eve-norris',
  source: 'travel_leg/v1',
  start_ts: t('19:50'),
  end_ts: t('20:00'),
  data: {
    from_visit_id: visit_home_evening.id,
    to_visit_id: visit_norris_eve.id,
    dominant_activity: 'walking',
    distance_m: 470,
    reading_count: 9,
  },
  path: walkPath(SARGENT, NORRIS, 9),
};

const leg_norris_eve_to_home: TravelLeg = {
  kind: 'travel_leg',
  id: 'leg-norris-eve-home',
  source: 'travel_leg/v1',
  start_ts: t('22:50'),
  end_ts: t('23:00'),
  data: {
    from_visit_id: visit_norris_eve.id,
    to_visit_id: visit_home_late.id,
    dominant_activity: 'on_bicycle',
    distance_m: 470,
    reading_count: 9,
  },
  path: walkPath(NORRIS, SARGENT, 9),
};

// ---------------------------------------------------------------------
// Topic chunks within each visit
// ---------------------------------------------------------------------

const topicChunks: TopicChunk[] = [
  // Home morning — wake-up scroll, then a bit of project work
  {
    kind: 'topic_chunk',
    id: 'tc-home-morning-1',
    parent_id: visit_home_morning.id,
    start_ts: t('06:50'),
    end_ts: t('07:30'),
    topic: 'Reels & messaging',
    category: 'play',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-home-morning-2',
    parent_id: visit_home_morning.id,
    start_ts: t('07:30'),
    end_ts: t('08:15'),
    topic: 'scrollantir',
    category: 'work',
  },

  // Tech — pre-class reading + COMP_SCI 348 lecture
  {
    kind: 'topic_chunk',
    id: 'tc-tech-1',
    parent_id: visit_tech.id,
    start_ts: t('08:25'),
    end_ts: t('09:00'),
    topic: 'reading',
    category: 'work',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-tech-2',
    parent_id: visit_tech.id,
    start_ts: t('09:00'),
    end_ts: t('09:55'),
    topic: 'COMP_SCI 348 lecture',
    category: 'work',
  },

  // Norris breakfast — eat + scroll + a bit of work
  {
    kind: 'topic_chunk',
    id: 'tc-norris-am-1',
    parent_id: visit_norris_breakfast.id,
    start_ts: t('10:05'),
    end_ts: t('10:30'),
    topic: 'breakfast',
    category: 'neutral',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-norris-am-2',
    parent_id: visit_norris_breakfast.id,
    start_ts: t('10:30'),
    end_ts: t('11:20'),
    topic: 'scrollantir',
    category: 'work',
  },

  // Mudd — split between two courses
  {
    kind: 'topic_chunk',
    id: 'tc-mudd-1',
    parent_id: visit_mudd.id,
    start_ts: t('11:30'),
    end_ts: t('12:15'),
    topic: 'COMP_SCI 348 hw',
    category: 'work',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-mudd-2',
    parent_id: visit_mudd.id,
    start_ts: t('12:15'),
    end_ts: t('13:00'),
    topic: 'MATH 230 hw',
    category: 'work',
  },

  // Norris lunch
  {
    kind: 'topic_chunk',
    id: 'tc-norris-pm-1',
    parent_id: visit_norris_lunch.id,
    start_ts: t('13:10'),
    end_ts: t('13:50'),
    topic: 'lunch',
    category: 'neutral',
  },

  // University Library — long deep-work block split into topics
  {
    kind: 'topic_chunk',
    id: 'tc-library-1',
    parent_id: visit_library.id,
    start_ts: t('14:00'),
    end_ts: t('15:30'),
    topic: 'scrollantir',
    category: 'work',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-library-2',
    parent_id: visit_library.id,
    start_ts: t('15:30'),
    end_ts: t('16:30'),
    topic: 'COMP_SCI 348 hw',
    category: 'work',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-library-3',
    parent_id: visit_library.id,
    start_ts: t('16:30'),
    end_ts: t('17:00'),
    topic: 'messaging',
    category: 'neutral',
  },

  // Lakefill — sunset stroll
  {
    kind: 'topic_chunk',
    id: 'tc-lakefill-1',
    parent_id: visit_lakefill.id,
    start_ts: t('17:15'),
    end_ts: t('18:00'),
    topic: 'lakefill walk',
    category: 'neutral',
  },

  // Home evening — short work block before heading out
  {
    kind: 'topic_chunk',
    id: 'tc-home-eve-1',
    parent_id: visit_home_evening.id,
    start_ts: t('18:15'),
    end_ts: t('19:50'),
    topic: 'scrollantir',
    category: 'work',
  },

  // Norris evening — dinner with friends, then hangout
  {
    kind: 'topic_chunk',
    id: 'tc-norris-eve-1',
    parent_id: visit_norris_eve.id,
    start_ts: t('20:00'),
    end_ts: t('21:00'),
    topic: 'dinner',
    category: 'neutral',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-norris-eve-2',
    parent_id: visit_norris_eve.id,
    start_ts: t('21:00'),
    end_ts: t('22:50'),
    topic: 'Discord & messaging',
    category: 'play',
  },

  // Home late — wind-down scrolling, then a late call
  {
    kind: 'topic_chunk',
    id: 'tc-home-late-1',
    parent_id: visit_home_late.id,
    start_ts: t('23:00'),
    end_ts: t('23:45'),
    topic: 'YouTube & Reels',
    category: 'play',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-home-late-2',
    parent_id: visit_home_late.id,
    start_ts: t('23:45'),
    end_ts: tNext('00:45'),
    topic: 'late Discord call',
    category: 'play',
  },

  // In-transit chunks — phone use during walks, music during the bike.
  // Legs aren't activity-empty: Reels-while-walking and music-while-biking
  // are the rule, not the exception.
  {
    kind: 'topic_chunk',
    id: 'tc-leg-tech-norris-am-1',
    parent_id: leg_tech_to_norris_am.id,
    start_ts: t('09:55'),
    end_ts: t('10:05'),
    topic: 'Reels',
    category: 'play',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-leg-norris-am-mudd-1',
    parent_id: leg_norris_am_to_mudd.id,
    start_ts: t('11:20'),
    end_ts: t('11:30'),
    topic: 'Spotify',
    category: 'neutral',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-leg-lakefill-home-1',
    parent_id: leg_lakefill_to_home.id,
    start_ts: t('18:00'),
    end_ts: t('18:15'),
    topic: 'messaging',
    category: 'neutral',
  },
  {
    kind: 'topic_chunk',
    id: 'tc-leg-norris-eve-home-1',
    parent_id: leg_norris_eve_to_home.id,
    start_ts: t('22:50'),
    end_ts: t('23:00'),
    topic: 'Spotify',
    category: 'neutral',
  },
];

// ---------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------

const wake: Moment = {
  kind: 'moment',
  id: 'moment-wake',
  ts: t('06:50'),
  label: 'Woke up',
  glyph: '🛏',
  lat: SARGENT[1],
  lng: SARGENT[0],
  source_hint: 'sleep/v1',
};

// ---------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------

export const fixtureDate = D;

export const placeVisits: PlaceVisit[] = [
  visit_home_morning,
  visit_tech,
  visit_norris_breakfast,
  visit_mudd,
  visit_norris_lunch,
  visit_library,
  visit_lakefill,
  visit_home_evening,
  visit_norris_eve,
  visit_home_late,
];

export const travelLegs: TravelLeg[] = [
  leg_home_to_tech,
  leg_tech_to_norris_am,
  leg_norris_am_to_mudd,
  leg_mudd_to_norris_pm,
  leg_norris_pm_to_library,
  leg_library_to_lakefill,
  leg_lakefill_to_home,
  leg_home_eve_to_norris,
  leg_norris_eve_to_home,
];

export const topicChunksByVisit: TopicChunk[] = topicChunks;

export const moments: Moment[] = [wake];

// Combined list, chronologically ordered. Inner topic chunks are
// listed after their parent (visit or leg) so the timeline can render
// them inline.
export const timelineEntries: TimelineEntry[] = (() => {
  const outers: Array<Moment | PlaceVisit | TravelLeg> = [
    ...moments,
    ...placeVisits,
    ...travelLegs,
  ];
  outers.sort((a, b) => {
    const ta = a.kind === 'moment' ? a.ts : a.start_ts;
    const tb = b.kind === 'moment' ? b.ts : b.start_ts;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  const out: TimelineEntry[] = [];
  for (const o of outers) {
    out.push(o);
    if (o.kind === 'place_visit' || o.kind === 'travel_leg') {
      const children = topicChunks
        .filter((c) => c.parent_id === o.id)
        .sort((x, y) => (x.start_ts < y.start_ts ? -1 : 1));
      out.push(...children);
    }
  }
  return out;
})();

// Convenience lookups: id → visit / leg. The map pane reads visitById
// for travel-leg endpoints, and both maps for topic-chunk parents
// (a chunk parents to either a visit or a leg).
export const visitById: Record<string, PlaceVisit> = Object.fromEntries(
  placeVisits.map((v) => [v.id, v]),
);

export const legById: Record<string, TravelLeg> = Object.fromEntries(
  travelLegs.map((l) => [l.id, l]),
);
