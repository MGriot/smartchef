import { useEffect } from 'react';
import { setTitleBarSurface } from '../lib/applySettings';

/** While mounted, the desktop window buttons take the bare page's colour
 *  instead of the header's: for screens that have no AppLayout header. */
export function usePageTitleBar(): void {
  useEffect(() => {
    setTitleBarSurface('page');
    return () => setTitleBarSurface('header');
  }, []);
}

/**
 * Desktop only, in effect: on a page without AppLayout's header (the
 * centred sign-in / setup cards) this invisible strip is what the window
 * can be dragged by, since the native title bar is gone. Its height is the
 * title-bar area Electron reports, so it is 0px in a browser and on Android.
 */
export default function WindowDragStrip() {
  usePageTitleBar();
  return (
    <div
      aria-hidden="true"
      className="app-drag fixed top-0 left-0 z-0"
      style={{ height: 'env(titlebar-area-height, 0px)', right: 'var(--wco-right)' }}
    />
  );
}
