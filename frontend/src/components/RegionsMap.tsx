import React, { Suspense, lazy } from 'react';
import type { ComponentProps } from 'react';
import type RegionsMapView from './RegionsMapView';

// ════════════════════════════════════════════════════════════════════════
// Lazy shell around the real map.
//
// The map pulls in leaflet plus lib/worldGeo's 739KB of country boundaries,
// and RecipeDetail imported it eagerly — so opening *any* recipe downloaded
// and parsed the whole world atlas, whether or not that recipe had a region
// to show. The maps were already rendered conditionally; only the import
// was not.
//
// Keeping the wrapper under the original filename means no call site
// changes and none can accidentally reintroduce the eager import.
// ════════════════════════════════════════════════════════════════════════

const View = lazy(() => import('./RegionsMapView'));

/** Reserves the map's height while its chunk loads, so the page does not
 *  jump when it arrives. */
function MapSkeleton() {
  return <div className="w-full h-64 rounded-2xl bg-zinc-100 dark:bg-zinc-800 animate-pulse" />;
}

export default function RegionsMap(props: ComponentProps<typeof RegionsMapView>) {
  return (
    <Suspense fallback={<MapSkeleton />}>
      <View {...props} />
    </Suspense>
  );
}
