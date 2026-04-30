// Place display-label resolver.
//
// Most place_visits already carry a friendly `place.name`
// ("Willard Hall"); the dashboard renders those verbatim. The exception
// is OSM polygons we landed on without a real `name` tag — the deriver
// stores them as `building:7088849` / `landuse:1234` / `poi_label:567`.
// Showing those raw is debug noise; we re-render them as
// "Unnamed dormitory" / "Unnamed parking" / etc., using the Mapbox
// feature `type` / `class` we stashed in `places.metadata.mapbox`.
//
// Resolution order against `metadata.mapbox`:
//   1. `type` (highest signal — Mapbox's specific label like "dormitory")
//   2. `class` (broader bucket — "education", "residential")
//   3. literal "Unnamed building" / "Unnamed area" / "Unnamed POI"
//
// Hyphenated/snake-cased Mapbox tags become spaced and lowercased
// ("retail_centre" → "retail centre"); the prefix is "Unnamed".

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchUnnamedPlaceMeta, type PlaceMeta } from './api';

const FALLBACK_BY_LAYER: Record<string, string> = {
  building: 'Unnamed building',
  landuse: 'Unnamed area',
  poi_label: 'Unnamed point',
};

// Some Mapbox `type` values don't read well as a display noun even
// though they're technically correct (e.g. "yes" for an unspecified
// building tag). Skip those and let the layer fallback take over.
const UNHELPFUL_TYPES = new Set(['yes', 'no', '', 'unknown']);

function prettifyTag(tag: string): string {
  return tag.replace(/[_-]+/g, ' ').toLowerCase().trim();
}

function isPlaceholderName(name: string): boolean {
  return /^(building|landuse|poi_label):\d+$/.test(name);
}

function layerOf(placeholderName: string): string {
  const idx = placeholderName.indexOf(':');
  return idx > 0 ? placeholderName.slice(0, idx) : '';
}

function labelFromMeta(name: string, meta: PlaceMeta | undefined): string {
  const mapbox = meta?.metadata?.mapbox as Record<string, unknown> | undefined;
  const layer = layerOf(name);
  // Try `type` first, then `class`. Mapbox's `type` is the specific
  // tag ("dormitory"); `class` is the higher-level bucket.
  for (const key of ['type', 'class']) {
    const raw = mapbox?.[key];
    if (typeof raw === 'string' && !UNHELPFUL_TYPES.has(raw.toLowerCase())) {
      return `Unnamed ${prettifyTag(raw)}`;
    }
  }
  return FALLBACK_BY_LAYER[layer] ?? 'Unnamed place';
}

export type PlaceLabels = {
  // Returns a display-ready label. Pass through real names verbatim;
  // rewrite placeholder names ("building:7088849") to "Unnamed X" using
  // the cached Mapbox metadata.
  display: (name: string | null | undefined) => string;
  isLoading: boolean;
};

export function usePlaceLabels(): PlaceLabels {
  const q = useQuery({
    queryKey: ['places-meta-unnamed'],
    queryFn: fetchUnnamedPlaceMeta,
    // Effectively-infinite — places only change when the user moves to
    // a brand-new building. A page refresh clears this anyway.
    staleTime: Infinity,
  });
  return useMemo(() => {
    const byName: Record<string, PlaceMeta> = {};
    for (const r of q.data ?? []) byName[r.name] = r;
    return {
      isLoading: q.isLoading,
      display: (name) => {
        if (name == null || name === '') return 'Unknown place';
        if (!isPlaceholderName(name)) return name;
        return labelFromMeta(name, byName[name]);
      },
    };
  }, [q.data, q.isLoading]);
}
