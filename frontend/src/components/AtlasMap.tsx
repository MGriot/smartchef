import React, { Suspense, lazy } from 'react';
import type { ComponentProps } from 'react';
import type AtlasMapView from './AtlasMapView';

// Lazy shell — see RegionsMap.tsx for why the map is not imported eagerly.
export type { AtlasMapProps } from './AtlasMapView';

const View = lazy(() => import('./AtlasMapView'));

export default function AtlasMap(props: ComponentProps<typeof AtlasMapView>) {
  return (
    <Suspense fallback={<div className="w-full h-[520px] rounded-3xl bg-zinc-100 dark:bg-zinc-800 animate-pulse" />}>
      <View {...props} />
    </Suspense>
  );
}
