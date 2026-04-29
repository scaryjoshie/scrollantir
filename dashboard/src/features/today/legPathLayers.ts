// Travel-leg path rendering: one Mapbox GeoJSON source, one line layer
// per `dominant_activity`. Each mode owns its own color/width/pattern
// in MODE_STYLES — adding a new mode (e.g. e-scooter) is a config edit
// here, never a touch to MapPane.
//
// All layers go in the Standard style's `middle` slot so the path
// renders above roads but below 3D buildings and labels — a building
// between camera and a far end of the path correctly occludes the line.
//
// Animation: modes with an animated dash pattern share a single RAF
// loop driven by the wall-clock timestamp. `tickLegPathAnimation` is
// called once per frame from the host; it updates each animated layer's
// dasharray with the current phase.

import type { Map as MapboxMap } from 'mapbox-gl';
import type { TravelActivity } from './types';

const SOURCE_ID = 'leg-path';
const SLOT = 'middle' as const;
const LAYER_ID_PREFIX = 'leg-path-line-';

// Coarse per-mode color palette, picked from the dashboard's logo
// gradient (#6B8EF2 blue, #C79BD8 purple, #7DB98A green) so legs read
// as a family while staying distinguishable at a glance.
//
// Why per-mode and not just per-walking-vs-not: a bike trip and a drive
// trip carry very different real-world meaning. Collapsing them into a
// single "non-walking" stroke loses information; clicking through a
// day's events should make mode legible without reading the chip.
type DashPattern = {
  kind: 'dash';
  dash: number; // line-width units
  gap: number;  // line-width units
  animated: boolean;
};
type StrokePattern = { kind: 'solid' } | DashPattern;

type ModeStyle = {
  color: string;
  width: number;
  capStyle: 'butt' | 'round';
  pattern: StrokePattern;
};

// Every transport mode renders as an animated dashed trace — the
// dashes-flowing-along-a-line idiom is what communicates "this is a
// recorded GPS path", and that meaning applies to bikes and cars
// just as much as to feet. Mode is differentiated by:
//   - color (per-mode hue from the dashboard's logo gradient)
//   - dash dimensions (small steps for walking, longer strides for
//     biking, long sweeps for driving)
//
// Animation cycle wall-clock time is the same across modes, so a
// longer-period dash naturally reads as faster motion — matching the
// real-world speed ordering of the modes without requiring per-mode
// animation timing.
//
// `still` is the only solid mode: it represents a non-moving sample
// and there's no flow to express.
export const MODE_STYLES: Record<TravelActivity, ModeStyle> = {
  walking: {
    color: '#6B8EF2',
    width: 4,
    capStyle: 'butt',
    pattern: { kind: 'dash', dash: 1.5, gap: 2, animated: true },
  },
  on_bicycle: {
    color: '#7DB98A',
    width: 4.5,
    capStyle: 'butt',
    pattern: { kind: 'dash', dash: 2.5, gap: 2, animated: true },
  },
  in_vehicle: {
    color: '#C79BD8',
    width: 5,
    capStyle: 'butt',
    pattern: { kind: 'dash', dash: 4, gap: 2.5, animated: true },
  },
  running: {
    color: '#E07B5C',
    width: 4,
    capStyle: 'butt',
    pattern: { kind: 'dash', dash: 2, gap: 1.5, animated: true },
  },
  still: {
    color: '#9DA0A6',
    width: 3,
    capStyle: 'round',
    pattern: { kind: 'solid' },
  },
};

// Dash-cycle animation runs at the wall-clock period below. All
// animated modes share the same period — phases are computed per-mode
// from each pattern's own dash+gap so they stay perceptually similar
// regardless of pattern dimensions.
const DASH_CYCLE_MS = 3500;
const DASH_QUANTUM = 0.05;

function dasharrayForPhase(p: DashPattern, phase: number): number[] {
  const { dash, gap } = p;
  const period = dash + gap;
  const wrapped = ((phase % period) + period) % period;
  if (wrapped <= dash) {
    return [wrapped, gap, dash - wrapped];
  }
  return [0, wrapped - dash, dash, period - wrapped];
}

function layerIdFor(mode: TravelActivity): string {
  return `${LAYER_ID_PREFIX}${mode}`;
}

// One-time setup. Idempotent: bails if the source already exists, so
// it's safe to call from a `style.load` handler that may fire more
// than once (e.g. on style swaps).
export function setupLegPathLayers(map: MapboxMap): void {
  if (map.getSource(SOURCE_ID)) return;

  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  for (const [modeKey, style] of Object.entries(MODE_STYLES)) {
    const mode = modeKey as TravelActivity;
    const paint: Record<string, unknown> = {
      'line-color': style.color,
      'line-width': style.width,
      'line-opacity': 0.92,
      // Emissive keeps the stroke legible across all four light
      // presets — without this, paths get muddy at dusk/night.
      'line-emissive-strength': 1,
    };
    if (style.pattern.kind === 'dash') {
      paint['line-dasharray'] = dasharrayForPhase(style.pattern, 0);
    }
    map.addLayer({
      id: layerIdFor(mode),
      type: 'line',
      slot: SLOT,
      source: SOURCE_ID,
      filter: ['==', ['get', 'mode'], mode],
      layout: { 'line-cap': style.capStyle, 'line-join': 'round' },
      paint,
    });
  }
}

// Module-scoped record of the mode currently drawn on the leg-path
// source. The animation tick reads this so it only updates the *one*
// layer that has a feature — without it, we'd call setPaintProperty
// on every animated mode's layer every frame (most of which have
// nothing to draw), which is the main source of dash-animation
// stutter under contention with Mapbox's own render loop.
let activeMode: TravelActivity | null = null;

// Set the source to a single line feature for `mode`, or empty out the
// source if path is null. Routing to the right layer happens via the
// per-mode filter on `properties.mode`.
export function setLegPath(
  map: MapboxMap,
  path: Array<[number, number]> | null,
  mode: TravelActivity | null,
): void {
  const src = map.getSource(SOURCE_ID) as
    | { setData: (data: GeoJSON.GeoJSON) => void }
    | undefined;
  if (!src) return;
  if (!path || !mode) {
    activeMode = null;
    src.setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  activeMode = mode;
  src.setData({
    type: 'Feature',
    properties: { mode },
    geometry: { type: 'LineString', coordinates: path },
  });
}

// Step the dash animation. Called once per frame by the host's RAF
// loop. Returns the quantized step so the host can short-circuit
// when nothing changed (avoids wasted setPaintProperty calls).
//
// `lastStep` is the previously returned step; pass -1 on first call.
// Bails immediately when:
//   - no path is drawn (activeMode null)
//   - the active mode's pattern isn't an animated dash
//   - the quantized step is unchanged
// — collapsing the steady-state cost to a single integer comparison
// per frame plus, on actual step changes, exactly one setPaintProperty.
export function tickLegPathAnimation(
  map: MapboxMap,
  ts: number,
  lastStep: number,
): number {
  if (!activeMode) return lastStep;
  const style = MODE_STYLES[activeMode];
  if (style.pattern.kind !== 'dash' || !style.pattern.animated) return lastStep;

  const cyclePhase = (ts % DASH_CYCLE_MS) / DASH_CYCLE_MS;
  const step = Math.floor(cyclePhase / DASH_QUANTUM);
  if (step === lastStep) return lastStep;

  const layerId = layerIdFor(activeMode);
  if (!map.getLayer(layerId)) return lastStep;

  // Map cycle position 0..1 onto this mode's full dash+gap period —
  // keeps relative motion comparable across modes despite different
  // pattern dimensions.
  const period = style.pattern.dash + style.pattern.gap;
  const phase = step * DASH_QUANTUM * period;
  try {
    map.setPaintProperty(
      layerId,
      'line-dasharray',
      dasharrayForPhase(style.pattern, phase),
    );
  } catch {
    /* layer not ready yet; next tick will retry */
  }

  return step;
}
