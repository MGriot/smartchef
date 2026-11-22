import WindowControls from './WindowControls';

/**
 * Desktop only, in effect: a screen without AppLayout's header (the centred
 * sign-in / setup cards) still needs something to drag the window by and
 * the window's own buttons, since there is no native title bar. Its height
 * is --window-bar-h, which is 0 in a browser and on Android.
 */
export default function WindowDragStrip() {
  return (
    <div
      className="app-drag fixed inset-x-0 top-0 z-40 flex items-center justify-end pr-2"
      style={{ height: 'var(--window-bar-h)' }}
    >
      <WindowControls />
    </div>
  );
}
