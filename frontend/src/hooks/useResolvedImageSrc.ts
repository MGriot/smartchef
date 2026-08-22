import { useEffect, useState } from 'react';
import { resolveImageSrc, isLocalImagePath } from '../lib/localImages';

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
 *  invent a second one. */
export function useResolvedImageSrc(value: string | null | undefined): string | null {
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    if (!value) {
      setResolved(null);
      return;
    }
    if (!isLocalImagePath(value)) {
      setResolved(value);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setResolved(null);

    resolveImageSrc(value)
      .then((src) => {
        if (cancelled) {
          if (src.startsWith('blob:')) URL.revokeObjectURL(src);
          return;
        }
        if (src.startsWith('blob:')) objectUrl = src;
        setResolved(src);
      })
      .catch((err) => {
        console.error('SmartChef: failed to resolve local image', value, err);
        if (!cancelled) setResolved(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [value]);

  return resolved;
}
