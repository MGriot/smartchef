import { useEffect, useState } from 'react';
import { resolveImageSrc, isLocalImagePath, peekResolvedImageSrc } from '../lib/localImages';

/** Resolves a stored image value into something safe to drop straight into
 *  `<img src>`. Most values (an absolute http(s) URL, a root-relative
 *  bundled asset path) are already directly loadable and pass through
 *  unchanged. A standalone-mode content-addressed path (`images/<hash>.ext`,
 *  as produced by localImages.ts's storeImage()) is NOT directly loadable —
 *  it needs an async per-platform resolve step (Capacitor.convertFileSrc()
 *  on Android, a Blob object URL read over Electron's IPC bridge on
 *  Electron) — every call site that renders a DB-stored image field needs
 *  this, not just the upload widgets, since the same relative path is what
 *  gets saved and re-loaded on every future render.
 *
 *  Returns null while a local path is still resolving, or when there's no
 *  value at all — callers already have their own "no image" fallback
 *  (an icon, a default photo) for the null case, so this hook doesn't
 *  invent a second one. An already-resolved path skips that null frame
 *  entirely: the initial state is seeded from localImages.ts's cache, so
 *  re-entering the gallery paints its covers on the first render instead of
 *  flashing every placeholder again. */
export function useResolvedImageSrc(value: string | null | undefined): string | null {
  const [resolved, setResolved] = useState<string | null>(() => initialFor(value));

  useEffect(() => {
    if (!value) {
      setResolved(null);
      return;
    }
    if (!isLocalImagePath(value)) {
      setResolved(value);
      return;
    }

    const cached = peekResolvedImageSrc(value);
    if (cached) {
      setResolved(cached);
      return;
    }

    let cancelled = false;
    setResolved(null);

    resolveImageSrc(value)
      .then((src) => {
        if (!cancelled) setResolved(src);
      })
      .catch((err) => {
        console.error('SmartChef: failed to resolve local image', value, err);
        if (!cancelled) setResolved(null);
      });

    // No URL.revokeObjectURL here any more: the object URL is owned by
    // localImages.ts's session cache and shared with every other component
    // showing the same image, so revoking it on one unmount used to be safe
    // only because nothing else could hold it. Eviction there is what
    // releases it now.
    return () => {
      cancelled = true;
    };
  }, [value]);

  return resolved;
}

function initialFor(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!isLocalImagePath(value)) return value;
  return peekResolvedImageSrc(value);
}
