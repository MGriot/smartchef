import { useEffect, useState } from 'react';

// ════════════════════════════════════════════════════════════════════════
// SmartChef — media queries as a hook
//
// Almost all of this app's responsive behaviour is static Tailwind classes,
// which is the right default. This is for the cases where a breakpoint has
// to change what is *rendered* rather than how it looks — a control that is
// not merely invisible at a given size but genuinely inapplicable there, and
// so should be out of the a11y tree and the tab order too.
//
// Extracted from the hand-rolled listener that lived inline in Home.tsx, and
// hardened for the two engines this ships into: the Electron build is
// Chromium 114, and Android's WebView is whatever the device shipped with.
// Safari below 14 (and some old WebViews) only implement the deprecated
// addListener/removeListener pair, so both are wired up.
// ════════════════════════════════════════════════════════════════════════

type LegacyMediaQueryList = MediaQueryList & {
  addListener?: (cb: (e: MediaQueryListEvent) => void) => void;
  removeListener?: (cb: (e: MediaQueryListEvent) => void) => void;
};

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    // matchMedia is absent in the vitest/node environment this repo's suite
    // runs in, and during any non-browser render. `false` is the safe answer:
    // every caller below treats it as the narrow case, which is the layout
    // that works everywhere.
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query) as LegacyMediaQueryList;
    // Re-read on (re)subscribe: the query can have changed between the
    // initial state and this effect, e.g. a rotation during hydration.
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    if (mql.addEventListener) {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    mql.addListener?.(handler);
    return () => mql.removeListener?.(handler);
  }, [query]);

  return matches;
}

/** Tailwind's `sm` breakpoint, as a JS value.
 *
 *  This is the width at which the gallery's multi-column grid starts to
 *  apply at all — below it, cards are always a single column because they
 *  get crushed otherwise. Kept as a named constant so the JS gate and the
 *  `sm:` classes around it can't drift apart. */
export const SM_BREAKPOINT_PX = 640;

/** True when the viewport is wide enough for a multi-column layout. On a
 *  phone that amounts to "is it turned sideways"; on a tablet it holds either
 *  way up, which is correct — the grid really does work there.
 *
 *  Deliberately width, not `(orientation: …)`: what the gallery grid actually
 *  depends on is how much room a row of cards has, and a tablet held upright
 *  has plenty. Orientation would get that case wrong in both directions. */
export function useIsWideViewport(): boolean {
  return useMediaQuery(`(min-width: ${SM_BREAKPOINT_PX}px)`);
}
