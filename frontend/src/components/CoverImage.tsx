import { useState } from 'react';
import { useResolvedImageSrc } from '../hooks/useResolvedImageSrc';

export interface CoverImageProps {
  /** cover_image_url / coverImageUrl / a collection's cover_images[i] — may
   *  be a plain remote URL, a bundled asset path, or (standalone mode) a
   *  content-addressed local path from lib/localImages.ts's storeImage(),
   *  which useResolvedImageSrc() resolves before this ever hits an
   *  `<img src>`. */
  src?: string | null;
  alt: string;
  /** Applied to whichever element ends up rendering — the real `<img>` or
   *  the fallback (icon placeholder, or `fallbackSrc`'s own `<img>`) — so
   *  sizing/rounding/hover classes stay consistent regardless of which
   *  branch is active. */
  className?: string;
  iconSize?: number;
  /** A placeholder photo URL to show instead of the icon-in-a-box when
   *  there's no usable src — several pages used a fixed Unsplash URL
   *  directly as their `<img src>`'s fallback before this component
   *  existed; passing it here preserves that exact look. Omit for the
   *  plain icon placeholder (Home.tsx's original behavior). */
  fallbackSrc?: string;
}

/** Recipe/collection cover photos: never cached locally in server mode
 *  (plain remote URLs, unreachable offline), so a real URL failing to load
 *  falls back the same way a missing one does. Falls back to a local icon
 *  (no network) — or, if `fallbackSrc` is given, a fixed placeholder photo
 *  — both when there's no cover at all and when a real URL fails to load. */
export default function CoverImage({ src, alt, className = 'w-full h-full object-cover', iconSize = 40, fallbackSrc }: CoverImageProps) {
  const [failed, setFailed] = useState(false);
  const resolvedSrc = useResolvedImageSrc(src);

  if (!resolvedSrc || failed) {
    if (fallbackSrc) {
      return <img alt={alt} className={className} src={fallbackSrc} />;
    }
    return (
      <div className={`flex items-center justify-center bg-zinc-100 text-zinc-300 ${className}`}>
        <span className="material-symbols-outlined" style={{ fontSize: iconSize }}>restaurant</span>
      </div>
    );
  }

  return <img alt={alt} className={className} src={resolvedSrc} onError={() => setFailed(true)} />;
}

/** For a value that should render nothing at all when absent (no icon
 *  placeholder) — e.g. a recipe step's optional photo, previously
 *  `{step.imageUrl && <img src={step.imageUrl} .../>}`. Resolving a
 *  standalone-mode local path is async, so "absent" also covers "not
 *  resolved yet" for one render or two, same tradeoff CoverImage makes. */
export function ResolvedImage({ src, alt = '', className, onClick }: { src?: string | null; alt?: string; className: string; onClick?: () => void }) {
  const resolvedSrc = useResolvedImageSrc(src);
  if (!resolvedSrc) return null;
  return <img alt={alt} className={className} src={resolvedSrc} onClick={onClick} />;
}
