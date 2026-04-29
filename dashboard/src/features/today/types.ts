// Day-narrative timeline types. Mirror public.derived_events row shapes
// per data-model.md §4 (Per-kind data schema), pre-joined where the
// dashboard would otherwise need a SQL view.
//
// Static-mock phase: fixtures.ts hand-shapes these directly. Once
// place_visit/v1 + travel_leg/v1 ship server-side, these become the
// fetcher response types and the joins move to a SQL view.

export type PlaceCategory =
  | 'class'
  | 'residence'
  | 'food'
  | 'study'
  | 'social'
  | 'work'
  | 'mixed';

// public.derived_events row for source='place_visit/v1', joined with
// public.places. Eventually a SQL view does the join; for the mock the
// fixture pre-joins.
export type PlaceVisit = {
  kind: 'place_visit';
  id: string;
  source: 'place_visit/v1';
  start_ts: string; // ISO 8601
  end_ts: string;
  data: {
    place_id: string | null;
    lat: number;
    lng: number;
    brief_exit_count: number;
    // `true` for the latest visit when its end_ts is within ~30min of
    // the deriver run's window end — the user is likely still here.
    // The timeline renders open visits with a live "Since X" subtitle
    // and a pulsing dot instead of a closed time range.
    is_open: boolean;
  };
  place: {
    id: string;
    name: string;
    category: PlaceCategory;
    // OSM POI centroid — sits inside the building extrusion, unlike
    // visit `data.lat/lng` which usually lands at the entrance. The
    // map uses these to highlight the right 3D building.
    centroid_lat?: number;
    centroid_lng?: number;
  } | null;
};

export type TravelActivity =
  | 'walking'
  | 'on_bicycle'
  | 'in_vehicle'
  | 'running'
  | 'still';

// public.derived_events row for source='travel_leg/v1'. `path` is the
// chronological GPS samples during the leg; eventually fetched
// separately (or denormalized into `data`). For the mock the fixture
// inlines a hand-shaped path.
export type TravelLeg = {
  kind: 'travel_leg';
  id: string;
  source: 'travel_leg/v1';
  start_ts: string;
  end_ts: string;
  data: {
    from_visit_id: string;
    to_visit_id: string;
    dominant_activity: TravelActivity;
    distance_m: number;
    reading_count: number;
  };
  path: Array<[number, number]>; // [lng, lat] tuples (Mapbox order)
};

export type TopicCategory = 'work' | 'play' | 'neutral';

// A chronological chunk of activity within a place_visit *or* travel_leg,
// labeled with a single topic. Eventually produced by the heuristic rule
// pyramid (and later, project_attribution/v1 + session_summary/v1 LLM
// derivers). For the mock, hand-shaped in fixtures.
//
// Legs aren't activity-empty: phone use during walks (Reels, messaging),
// music during a bike or drive, etc. all attach here with parent_id
// pointing to the leg.
export type TopicChunk = {
  kind: 'topic_chunk';
  id: string;
  parent_id: string; // place_visit.id OR travel_leg.id
  start_ts: string;
  end_ts: string;
  topic: string;
  category: TopicCategory;
};

// Singular point-in-time entry for the timeline (e.g. wake = end of the
// previous night's sleep span). Lets the narrative open with "Woke up
// at 7:14" without conflating with a span derivation.
export type Moment = {
  kind: 'moment';
  id: string;
  ts: string;
  label: string;
  glyph: string; // emoji
  // Anchor for the map; usually the place where the moment happened.
  lat?: number;
  lng?: number;
  // Where this moment came from (drill-in hint).
  source_hint?: string; // e.g. 'sleep/v1'
};

export type TimelineEntry = PlaceVisit | TravelLeg | TopicChunk | Moment;
