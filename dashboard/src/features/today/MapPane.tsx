// Mapbox GL JS pane.
//
//   place_visit  → marker + ~50° pitch + building highlight at coords
//   travel_leg   → polyline along path + start/end pins, fitBounds
//   topic_chunk  → fly to parent visit's coords + same building highlight
//   moment       → fly to anchor coords if present
//
// Lighting preset is driven by the selected entry's local time-of-day
// (dawn / day / dusk / night), not the dashboard theme — the map
// represents *when* the event happened, not the user's current viewing
// context.
//
// Building highlight uses Mapbox Standard's `colorBuildingSelect`
// config + feature-state `select: true` on the building feature found
// at the visit's coords.

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type {
  TimelineEntry,
  PlaceVisit,
  TravelActivity,
  TravelLeg,
} from './types';
import { useTodayLookups, type TodayLookups } from './lookups';
import {
  setupLegPathLayers,
  setLegPath,
  tickLegPathAnimation,
} from './legPathLayers';
import type { GpsReading } from '@/lib/api';

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
const DEFAULT_CENTER: [number, number] = [-87.6004, 41.7912];
const STYLE = 'mapbox://styles/mapbox/standard';

const VISIT_PIN = '#C79BD8';        // dashboard's location accent
const START_PIN = '#9DA0A6';        // muted gray — leg origin
// Vivid red so the selected building's 3D extrusion reads obviously
// against the basemap. Mapbox Standard's `colorBuildingSelect` tints
// (rather than replaces) the building's color, so we want a saturated
// hue with enough contrast against the default building gray.
const BUILDING_HIGHLIGHT = '#E53935';

// Mapbox Standard's 3D buildings only render at ~z14+. Clamp leg
// fitBounds so wide-area legs still land inside the building zoom.
const MIN_LEG_ZOOM = 15.5;

type LightPreset = 'dawn' | 'day' | 'dusk' | 'night';

function presetForTime(iso: string): LightPreset {
  const hour = new Date(iso).getHours();
  // Mapbox Standard only has 4 lighting presets. By reusing `dawn` for
  // both sunrise AND golden hour, and `dusk` for both pre-dawn twilight
  // AND sunset twilight, we get a 7-step progression across the day:
  //   night → dusk → dawn → day → dawn → dusk → night
  // which feels much smoother than 3 transitions.
  if (hour < 5) return 'night';     // late-night / pre-dawn dark
  if (hour < 6) return 'dusk';      // pre-dawn twilight
  if (hour < 8) return 'dawn';      // sunrise
  if (hour < 17) return 'day';      // full daylight
  if (hour < 19) return 'dawn';     // golden hour (warm low sun, reused)
  if (hour < 21) return 'dusk';     // sunset twilight
  return 'night';                    // late evening dark
}

// Pick a camera bearing so the path's principal axis (PCA) lies
// horizontally on screen. This keeps long N-S paths from getting cropped
// in our wide map pane and adapts to irregular/multi-segment shapes
// instead of just using start→end.
function bearingForPath(path: Array<[number, number]>): number {
  if (path.length < 2) return 0;
  const meanLat = path.reduce((s, p) => s + p[1], 0) / path.length;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  let mx = 0;
  let my = 0;
  for (const [lng, lat] of path) {
    mx += lng * cosLat;
    my += lat;
  }
  mx /= path.length;
  my /= path.length;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (const [lng, lat] of path) {
    const x = lng * cosLat - mx;
    const y = lat - my;
    cxx += x * x;
    cyy += y * y;
    cxy += x * y;
  }
  // Math-convention angle of the dominant eigenvector (+x east, +y north).
  const alpha = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  // Mapbox bearing is the compass direction the camera faces; setting it
  // to -alpha aligns the principal axis with the screen's x-axis.
  let beta = -(alpha * 180) / Math.PI;
  if (beta > 180) beta -= 360;
  if (beta < -180) beta += 360;
  return beta;
}

function timeForEntry(entry: TimelineEntry | null): string | null {
  if (!entry) return null;
  if (entry.kind === 'moment') return entry.ts;
  return entry.start_ts;
}

// Same accuracy cap as the travel_leg deriver (runtime/.../travel_leg.py
// path_accuracy_max_m = 75). Keeping the dashboard's raw-path fallback
// in lockstep with the deriver so a user_active span and an eventual
// travel_leg row don't disagree on which fixes are "good enough" to draw.
const RAW_PATH_ACCURACY_MAX_M = 75;
// Below this point count the raw-path fallback is just visual noise —
// two pings 8m apart isn't a "trace". The user_active row stays selected
// but the map keeps its previous focus (Tenet 1: don't fake a path).
const RAW_PATH_MIN_POINTS = 2;

// Pull GPS readings whose timestamp falls in [startIso, endIso], filter
// to those with accuracy ≤ cap, return Mapbox [lng, lat] tuples in
// chronological order. Used to render a fallback polyline for spans the
// travel_leg deriver hasn't yet emitted (e.g. a walk in progress).
function rawPathForSpan(
  readings: GpsReading[],
  startIso: string,
  endIso: string,
): Array<[number, number]> {
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const out: Array<[number, number]> = [];
  for (const r of readings) {
    const t = Date.parse(r.ts);
    if (t < startMs || t > endMs) continue;
    if (r.accuracy_m != null && r.accuracy_m > RAW_PATH_ACCURACY_MAX_M) continue;
    out.push([r.lng, r.lat]);
  }
  return out;
}

type CameraTarget =
  | {
      kind: 'point';
      lng: number;
      lat: number;
      pitch: number;
      // visit/chunk: highlight the building at this coord. moments don't.
      highlightBuilding: boolean;
      // For visits: the place's POI centroid (which sits inside the
      // building extrusion). queryRenderedFeatures uses this — not the
      // marker's lng/lat — so the highlight finds the right building
      // even when the user's GPS centroid is at the entrance, outside
      // the polygon. Falls back to the marker coords when null.
      buildingProbe?: { lat: number; lng: number };
    }
  | {
      kind: 'path';
      path: Array<[number, number]>;
      from: [number, number] | null;
      to: [number, number] | null;
      // dominant_activity drives per-mode stroke style — see
      // legPathLayers.ts MODE_STYLES.
      mode: TravelActivity;
    };

function visitTarget(v: PlaceVisit, pitch: number): CameraTarget {
  // Marker drops at the user's actual stay-centroid (where the GPS
  // readings clustered — usually the entrance). buildingProbe uses
  // the OSM POI centroid (inside the polygon) so the 3D highlight
  // finds the right building extrusion.
  const probe =
    v.place?.centroid_lat != null && v.place?.centroid_lng != null
      ? { lat: v.place.centroid_lat, lng: v.place.centroid_lng }
      : undefined;
  return {
    kind: 'point',
    lng: v.data.lng,
    lat: v.data.lat,
    pitch,
    highlightBuilding: true,
    buildingProbe: probe,
  };
}

function legTarget(leg: TravelLeg, lookups: TodayLookups): CameraTarget {
  const fromV = lookups.visitById[leg.data.from_visit_id];
  const toV = lookups.visitById[leg.data.to_visit_id];
  return {
    kind: 'path',
    path: leg.path,
    from: fromV ? [fromV.data.lng, fromV.data.lat] : null,
    to: toV ? [toV.data.lng, toV.data.lat] : null,
    mode: leg.data.dominant_activity,
  };
}

function targetForSelection(
  entry: TimelineEntry | null,
  lookups: TodayLookups,
  readings: GpsReading[],
): CameraTarget | null {
  if (!entry) return null;
  if (entry.kind === 'place_visit') return visitTarget(entry, 55);
  if (entry.kind === 'travel_leg') return legTarget(entry, lookups);
  if (entry.kind === 'topic_chunk') {
    // Chunk parents to a visit OR a leg. Match the parent's camera
    // treatment so e.g. "Spotify (during bike)" draws the leg path,
    // not a point at the start coord.
    const v = lookups.visitById[entry.parent_id];
    if (v) return visitTarget(v, 60);
    const leg = lookups.legById[entry.parent_id];
    if (leg) return legTarget(leg, lookups);
    return null;
  }
  if (entry.kind === 'sleep') {
    // Anchor at the place that contains the wake_ts — that's where
    // the user was sleeping. (Naps mid-day work the same way.) Falls
    // through to null if no containing visit (rare; e.g. cold-start
    // before place_visits derive).
    const wake = entry.end_ts;
    const containing = Object.values(lookups.visitById).find(
      (v) => v.start_ts <= wake && wake <= v.end_ts,
    );
    if (containing) return visitTarget(containing, 50);
    return null;
  }
  if (entry.kind === 'tracking_gap') {
    // Synthetic gap is a stretch of silence between two real entries.
    // Usually there's no GPS in the gap (that's why it's a gap), but
    // when raw readings DO exist for it (e.g. background fixes that
    // weren't enough to derive a visit), fall through to the
    // raw-path renderer — the user gets to see where the device was
    // pinging even though no higher-level row covered it.
    const path = rawPathForSpan(readings, entry.start_ts, entry.end_ts);
    if (path.length >= RAW_PATH_MIN_POINTS) {
      return { kind: 'path', path, from: null, to: null, mode: 'walking' };
    }
    return null;
  }
  if (entry.kind === 'user_active') {
    // user_active is a primitive activity span — the device was being
    // used during [start_ts, end_ts]. Render any raw GPS readings in
    // that span as a polyline so a walk-in-progress (no destination
    // visit yet → no travel_leg yet) is still visible on the map.
    // 'walking' is the default rendering mode; user_active rows don't
    // carry an activity classification, and walking is the most
    // common cause of an uncovered active-span on this user's data.
    // When there are no usable fixes (the device was active but not
    // moving / GPS off), fall through to null so the map keeps its
    // previous focus rather than zooming to whatever default sits at
    // (0,0).
    const path = rawPathForSpan(readings, entry.start_ts, entry.end_ts);
    if (path.length >= RAW_PATH_MIN_POINTS) {
      return { kind: 'path', path, from: null, to: null, mode: 'walking' };
    }
    return null;
  }
  // moment
  if (entry.lat != null && entry.lng != null) {
    return {
      kind: 'point',
      lng: entry.lng,
      lat: entry.lat,
      pitch: 50,
      // Wake/nap Moments anchor at the building's POI centroid (set
      // by Today.tsx from the containing visit's place). That coord
      // sits inside the building polygon — the same probe that
      // works for place_visit highlights.
      highlightBuilding: true,
      buildingProbe: { lat: entry.lat, lng: entry.lng },
    };
  }
  return null;
}

type BuildingFs = {
  source: string;
  sourceLayer: string;
  id: string | number;
};

export default function MapPane({
  selected,
  readings,
}: {
  selected: TimelineEntry | null;
  // Day-window raw GPS readings, fetched once by Today.tsx. Used for
  // the user_active / tracking_gap fallback path renderer; ignored
  // for visit / leg / chunk / sleep / moment selections.
  readings: GpsReading[];
}) {
  const lookups = useTodayLookups();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const styleReadyRef = useRef(false);
  const buildingFsRef = useRef<BuildingFs | null>(null);
  const dashRafRef = useRef<number | null>(null);
  const dashStepRef = useRef(-1);

  // Bring up the map once on mount.
  useEffect(() => {
    if (!TOKEN || !containerRef.current) return;
    mapboxgl.accessToken = TOKEN;

    // Single RAF loop drives all dash-animated leg-path layers (walking,
    // running, etc.). The module computes the per-mode dasharray from
    // the timestamp and skips work when the quantized step is unchanged.
    const startDashAnimation = () => {
      if (dashRafRef.current != null) return;
      const tick = (ts: number) => {
        const map = mapRef.current;
        if (!map) {
          dashRafRef.current = null;
          return;
        }
        dashStepRef.current = tickLegPathAnimation(map, ts, dashStepRef.current);
        dashRafRef.current = requestAnimationFrame(tick);
      };
      dashRafRef.current = requestAnimationFrame(tick);
    };

    const m = new mapboxgl.Map({
      container: containerRef.current,
      style: STYLE,
      center: DEFAULT_CENTER,
      zoom: 15.5,
      pitch: 50,
      bearing: -20,
      antialias: true,
    });

    m.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right');

    m.on('style.load', () => {
      // Default preset until the first selection arrives.
      try {
        m.setConfigProperty('basemap', 'lightPreset', 'day');
      } catch {
        /* older style; ignore */
      }
      // Building highlight color used when feature state .select = true.
      try {
        m.setConfigProperty('basemap', 'colorBuildingSelect', BUILDING_HIGHLIGHT);
      } catch {
        /* older style; ignore */
      }
      // Travel-leg path layers (one per mode + front/ghost variant; see
      // legPathLayers.ts MODE_STYLES). The ghost variant lives in slot
      // 'top' so paths stay visible inside/behind buildings.
      setupLegPathLayers(m);

      // Push the 3D-building minzoom out so they don't pop out as soon
      // as the user zooms a notch beyond a leg's fitBounds. Mapbox
      // Standard encapsulates its layers, but we can iterate the
      // resolved style and lower minzoom on whatever fill-extrusion
      // layer paints the buildings. Best-effort: if the style is from
      // a version we can't introspect, just skip silently.
      try {
        const styleLayers = m.getStyle()?.layers ?? [];
        for (const layer of styleLayers) {
          if (
            layer.type === 'fill-extrusion' &&
            /building/i.test(layer.id)
          ) {
            m.setLayerZoomRange(layer.id, 13, 24);
          }
        }
      } catch {
        /* style introspection unsupported; ignore */
      }

      styleReadyRef.current = true;
      startDashAnimation();
    });

    mapRef.current = m;
    return () => {
      styleReadyRef.current = false;
      if (dashRafRef.current != null) {
        cancelAnimationFrame(dashRafRef.current);
        dashRafRef.current = null;
      }
      m.remove();
      mapRef.current = null;
      markersRef.current = [];
      buildingFsRef.current = null;
    };
  }, []);

  // React to the host's selection.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;

    // Guards against the once('idle') / once('style.load') callbacks
    // firing AFTER the user has selected something else. Without this,
    // the in-flight idle handler resolves against the OLD probe coord
    // and writes the wrong building into buildingFsRef — visible as a
    // stale red highlight on a building that no longer matches the
    // current selection.
    let cancelled = false;

    const apply = () => {
      if (cancelled) return;
      // 1. Lighting preset from the entry's time-of-day.
      const t = timeForEntry(selected);
      if (t) {
        try {
          m.setConfigProperty('basemap', 'lightPreset', presetForTime(t));
        } catch {
          /* ignore */
        }
      }

      // 2. Clear prior markers + building highlight before applying new.
      markersRef.current.forEach((mk) => mk.remove());
      markersRef.current = [];
      if (buildingFsRef.current) {
        try {
          m.removeFeatureState(buildingFsRef.current);
        } catch {
          /* ignore */
        }
        buildingFsRef.current = null;
      }

      const target = targetForSelection(selected, lookups, readings);
      if (!target) return;

      if (target.kind === 'point') {
        // Clear any prior leg polyline.
        setLegPath(m, null, null);

        // Pin at the point.
        markersRef.current.push(
          new mapboxgl.Marker({ color: VISIT_PIN })
            .setLngLat([target.lng, target.lat])
            .addTo(m),
        );

        m.flyTo({
          center: [target.lng, target.lat],
          zoom: 16.5,
          pitch: target.pitch,
          bearing: -20,
          duration: 1200,
          essential: true,
        });

        // Building highlight: wait until movement settles + buildings
        // are rendered, then query and tag the feature with select=true.
        // Probe the OSM POI centroid (sits INSIDE the polygon) when
        // available — falling back to the marker's coords (which often
        // land at the entrance, just outside the polygon) means the
        // queryRenderedFeatures hit the building extrusion reliably.
        if (target.highlightBuilding) {
          const probe = target.buildingProbe ?? {
            lat: target.lat,
            lng: target.lng,
          };
          m.once('idle', () => {
            if (cancelled) return;
            const point = m.project([probe.lng, probe.lat]);
            const features = m.queryRenderedFeatures(point);
            const bldg = features.find(
              (f) => f.sourceLayer === 'building' && f.id != null,
            );
            if (bldg && bldg.id != null && bldg.source) {
              const fs: BuildingFs = {
                source: bldg.source,
                sourceLayer: bldg.sourceLayer ?? 'building',
                id: bldg.id,
              };
              try {
                m.setFeatureState(fs, { select: true });
                buildingFsRef.current = fs;
              } catch {
                /* feature state unsupported; silently skip */
              }
            }
          });
        }
      } else {
        // Path: draw polyline, drop start + end pins, fit bounds.
        // legPathLayers routes the feature to the right per-mode
        // layer via the layer's filter on `properties.mode`.
        setLegPath(m, target.path, target.mode);

        if (target.from) {
          const el = document.createElement('div');
          el.style.cssText = [
            'width:12px',
            'height:12px',
            'border-radius:50%',
            `background:${START_PIN}`,
            'border:2px solid #fff',
            'box-shadow:0 0 0 1px rgba(0,0,0,0.35)',
          ].join(';');
          markersRef.current.push(
            new mapboxgl.Marker({ element: el }).setLngLat(target.from).addTo(m),
          );
        }
        if (target.to) {
          markersRef.current.push(
            new mapboxgl.Marker({ color: VISIT_PIN }).setLngLat(target.to).addTo(m),
          );
        }

        if (target.path.length >= 2) {
          let minLng = Infinity;
          let minLat = Infinity;
          let maxLng = -Infinity;
          let maxLat = -Infinity;
          for (const [lng, lat] of target.path) {
            if (lng < minLng) minLng = lng;
            if (lat < minLat) minLat = lat;
            if (lng > maxLng) maxLng = lng;
            if (lat > maxLat) maxLat = lat;
          }
          const bounds: [[number, number], [number, number]] = [
            [minLng, minLat],
            [maxLng, maxLat],
          ];
          const bearing = bearingForPath(target.path);
          const cam = m.cameraForBounds(bounds, {
            padding: 80,
            pitch: 30,
            bearing,
          });
          if (cam && typeof cam.zoom === 'number' && cam.zoom < MIN_LEG_ZOOM) {
            m.easeTo({
              ...cam,
              zoom: MIN_LEG_ZOOM,
              pitch: 30,
              bearing,
              duration: 1200,
            });
          } else {
            m.fitBounds(bounds, {
              padding: 80,
              pitch: 30,
              bearing,
              duration: 1200,
            });
          }
        }
      }
    };

    if (styleReadyRef.current) apply();
    else m.once('style.load', apply);

    return () => {
      cancelled = true;
    };
  }, [selected, lookups, readings]);

  if (!TOKEN) {
    return (
      <div className="h-full w-full grid place-items-center bg-paper-panel">
        <div className="text-center text-sm text-ink-muted px-6 max-w-sm">
          <div className="font-medium text-ink">Mapbox token missing</div>
          <div className="mt-1 text-xs leading-relaxed">
            Set <code className="bg-paper-hover px-1 py-0.5 rounded">VITE_MAPBOX_TOKEN</code>{' '}
            in <code className="bg-paper-hover px-1 py-0.5 rounded">dashboard/.env.local</code>{' '}
            and restart the dev server.
          </div>
        </div>
      </div>
    );
  }

  return <div ref={containerRef} className="absolute inset-0" />;
}
