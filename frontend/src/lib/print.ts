// ════════════════════════════════════════════════════════════════════════
// SmartChef — Printing
//
// The layout work is all CSS (`@media print` in index.css); this module only
// owns the things CSS cannot answer: whether this platform can print, how to
// start it, and whether it can also write a PDF without the print dialog.
//
// The platform split is not defensive boilerplate. `window.print` EXISTS on
// Android's WebView — it is a real function — it simply does nothing when
// called: Android exposes printing through the native PrintManager, which a
// WebView does not wire up for you. So feature-detecting `typeof
// window.print === 'function'` says "yes" on exactly the platform where it
// silently fails. The Android app therefore prints through the
// SmartChefPrint plugin (lib/printBridge.ts), which hands the page on screen
// to PrintManager; its dialog has "Save as PDF" next to the real printers.
// Electron and any real browser (including Chrome on Android, which is a
// browser, not a WebView) print normally, and Electron can additionally
// render a PDF straight to a file (savePageAsPdf).
// ════════════════════════════════════════════════════════════════════════

import { Capacitor } from '@capacitor/core';
import { canPrintToPdf, printToPdfViaDialog } from './electronBridge';
import { SmartChefPrint, hasNativePrint } from './printBridge';

function isAndroidApp(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/** False only where printing cannot work: the Android app on a native build
 *  that predates the print plugin. Call sites use this to hide the action
 *  rather than offer a button that appears to do nothing. */
export function canPrint(): boolean {
  if (isAndroidApp()) return hasNativePrint();
  return typeof window !== 'undefined' && typeof window.print === 'function';
}

/** Opens the platform print dialog for the current page.
 *
 *  `documentTitle` matters more than it looks: it is what every "Save as
 *  PDF" destination proposes as the filename — browsers read it from
 *  document.title, Android from the print job's name — so without it every
 *  printed recipe would be saved as "SmartChef". On the web it is restored
 *  afterwards so the tab title does not stay changed. */
export async function printPage(documentTitle?: string): Promise<void> {
  if (!canPrint()) return;

  if (isAndroidApp()) {
    await SmartChefPrint.print({ jobName: sanitizeFilename(documentTitle || document.title) });
    return;
  }

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

/** True where a PDF can be written straight to a file, without the print
 *  dialog — Electron only. Elsewhere "Save as PDF" is a destination inside
 *  the print dialog, so printPage() already covers it. */
export function canSavePdfDirectly(): boolean {
  return canPrintToPdf();
}

/** US readers get Letter, everyone else A4 — what their printer paper and
 *  their PDF viewer's default both expect. */
function pageSizeFor(locale: string): 'A4' | 'Letter' {
  return /^en-(US|CA)$/i.test(locale) || /^es-(US|MX)$/i.test(locale) ? 'Letter' : 'A4';
}

/** Renders the current page with its print stylesheet into a PDF and opens
 *  a save dialog for it. Resolves to the path written, or null if the user
 *  cancelled. `footerLabel` is printed at the foot of every page beside the
 *  page number — Chromium 114 cannot number pages from CSS (it has no @page
 *  corner boxes), so this footer is the only way to number them. */
export async function savePageAsPdf(
  documentTitle: string,
  opts: { footerLabel?: string; dialogTitle?: string } = {},
): Promise<string | null> {
  const name = sanitizeFilename(documentTitle);
  const label = escapeHtml(opts.footerLabel ?? name);
  // printToPDF draws the footer at a tiny default size and in its own
  // document, so it carries its own inline style; the page's CSS never
  // reaches it.
  const footerTemplate =
    `<div style="width:100%;font-size:8px;color:#666;padding:0 14mm;display:flex;justify-content:space-between;font-family:sans-serif">` +
    `<span>${label}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
  return printToPdfViaDialog(`${name}.pdf`, {
    pageSize: pageSizeFor(typeof navigator !== 'undefined' ? navigator.language : 'en'),
    footerTemplate,
    dialogTitle: opts.dialogTitle,
  });
}

/** Trims what a filename cannot carry. Not security-sensitive — the
 *  platforms sanitize too — but a title full of slashes produces an ugly
 *  suggested filename. */
export function sanitizeFilename(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'SmartChef';
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
