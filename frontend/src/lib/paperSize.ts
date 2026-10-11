// ════════════════════════════════════════════════════════════════════════
// SmartChef — Paper size for the print views
//
// The recipe report, the menu card and the weekly plan are each laid out for
// a sheet of paper, so each needs to know which one: the sheet's width on
// screen, the @page the browser prints into, and the page size Electron's
// "Save PDF" renders. This module is the one place that answers all three.
//
// `@page` cannot be switched by a class — it is not an element — so the
// print views mount a <style data-print-page> while they are open (see
// usePageRule) and remove it on the way out. That keeps every other page
// (the shopping list) printing exactly as before.
// ════════════════════════════════════════════════════════════════════════

import { useEffect } from 'react';

export type PaperSize = 'A4' | 'Letter';
export type Orientation = 'portrait' | 'landscape';

export const PAPER_SIZES: PaperSize[] = ['A4', 'Letter'];

/** The @page margin, in mm. Matches index.css's print @page and Electron's
 *  0.55in PDF margin closely enough that the preview and the PDF agree. */
export const PAGE_MARGIN_MM = 14;

const PAPER_KEY = 'smartchef.print.paper';

const DIMENSIONS_MM: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
};

/** US readers get Letter, everyone else A4 — what their printer paper and
 *  their PDF viewer's default both expect. */
export function defaultPaperSize(locale: string): PaperSize {
  return /^en-(US|CA)$/i.test(locale) || /^es-(US|MX)$/i.test(locale) ? 'Letter' : 'A4';
}

export function isPaperSize(value: unknown): value is PaperSize {
  return value === 'A4' || value === 'Letter';
}

/** The remembered choice, or the locale's default. */
export function loadPaperSize(): PaperSize {
  try {
    const saved = localStorage.getItem(PAPER_KEY);
    if (isPaperSize(saved)) return saved;
  } catch { /* private mode — default */ }
  return defaultPaperSize(typeof navigator !== 'undefined' ? navigator.language : 'en');
}

export function savePaperSize(paper: PaperSize): void {
  try { localStorage.setItem(PAPER_KEY, paper); } catch { /* ignore */ }
}

/** The sheet's outer size in mm for an orientation. */
export function sheetSize(paper: PaperSize, orientation: Orientation = 'portrait'): { width: number; height: number } {
  const { width, height } = DIMENSIONS_MM[paper];
  return orientation === 'landscape' ? { width: height, height: width } : { width, height };
}

/** The printable area inside the margins, in mm. */
export function contentSize(paper: PaperSize, orientation: Orientation = 'portrait'): { width: number; height: number } {
  const { width, height } = sheetSize(paper, orientation);
  return { width: width - 2 * PAGE_MARGIN_MM, height: height - 2 * PAGE_MARGIN_MM };
}

/** The @page rule for a paper and orientation. */
export function pageRule(paper: PaperSize, orientation: Orientation = 'portrait'): string {
  return `@page { size: ${paper} ${orientation}; margin: ${PAGE_MARGIN_MM}mm; }`;
}

/** Applies the @page rule for as long as the calling page is mounted. */
export function usePageRule(paper: PaperSize, orientation: Orientation = 'portrait'): void {
  useEffect(() => {
    const style = document.createElement('style');
    style.setAttribute('data-print-page', '');
    style.textContent = pageRule(paper, orientation);
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, [paper, orientation]);
}
