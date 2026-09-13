// ════════════════════════════════════════════════════════════════════════
// SmartChef — Printing
//
// The layout work is all CSS (`@media print` in index.css); this module only
// owns the two things CSS cannot answer: whether this platform can print at
// all, and how to start it.
//
// The platform check is not defensive boilerplate. `window.print` EXISTS on
// Android's WebView — it is a real function — it simply does nothing when
// called: Android exposes printing through the native PrintManager, which a
// WebView does not wire up for you. So feature-detecting `typeof
// window.print === 'function'` says "yes" on exactly the platform where it
// silently fails, and a Print button there would look broken rather than
// unavailable. Electron and any real browser (including Chrome on Android,
// which is a browser, not a WebView) print normally.
//
// Adding phone printing later means a Capacitor plugin bridging to
// PrintManager; this module is where that would plug in, so no call site
// needs to learn about it.
// ════════════════════════════════════════════════════════════════════════

import { Capacitor } from '@capacitor/core';

/** False only on the Android WebView, where window.print() is a silent
 *  no-op. Call sites use this to hide the action rather than offer a button
 *  that appears to do nothing. */
export function canPrint(): boolean {
  if (typeof window === 'undefined' || typeof window.print !== 'function') return false;
  return !(Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android');
}

/** Opens the platform print dialog for the current page.
 *
 *  `documentTitle` matters more than it looks: browsers seed the
 *  "Save as PDF" filename from document.title, so without this every printed
 *  recipe would be saved as "SmartChef". It is restored afterwards so the
 *  tab title does not stay changed. */
export function printPage(documentTitle?: string): void {
  if (!canPrint()) return;

  const previous = document.title;
  if (documentTitle) document.title = sanitizeFilename(documentTitle);

  const restore = () => {
    document.title = previous;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);

  try {
    window.print();
  } finally {
    // Safari never fires afterprint; without this the title would stay
    // changed for the rest of the session. Running twice is harmless.
    setTimeout(restore, 1000);
  }
}

/** Trims what a Save-as-PDF filename cannot carry. Not security-sensitive —
 *  the browser sanitizes too — but a title full of slashes produces an ugly
 *  suggested filename. */
function sanitizeFilename(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'SmartChef';
}
