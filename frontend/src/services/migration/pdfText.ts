// ════════════════════════════════════════════════════════════════════════
// SmartChef — Reading a recipe out of a PDF
//
// A printed recipe page saved as a PDF almost always carries a real text
// layer, so it needs no OCR at all — which matters, because OCR is slow,
// needs a large model download, and is materially less accurate. This runs
// first and the photo/OCR path is only for images and for the rare
// scanned-image PDF.
//
// Two deliberate choices:
//
//   - The **legacy** pdf.js build. pdf.js 4.x's default bundle targets
//     browsers newer than the Electron 25 shell (Chromium 114) this app
//     ships as its desktop build; the legacy build is transpiled for
//     exactly that situation. Verifying against the dev browser would have
//     hidden the problem — see the project note about Chromium 114.
//
//   - Dynamically imported. pdf.js is over a megabyte; nobody who never
//     imports a PDF should pay for it at startup.
// ════════════════════════════════════════════════════════════════════════

/** How the text on one line is reassembled from pdf.js's positioned items. */
interface TextItemLike {
  str: string;
  transform: number[];
  hasEOL?: boolean;
}

export interface PdfExtraction {
  text: string;
  pageCount: number;
  /** True when the document had a text layer worth reading. A scanned
   *  cookbook page is a PDF full of images and no text, and the caller
   *  should send it down the OCR path instead of importing nothing. */
  hasTextLayer: boolean;
}

/** pdf.js gives every fragment an absolute position rather than lines, so
 *  fragments have to be grouped back into lines by their y coordinate.
 *  Without this an ingredient list comes back as one run-on paragraph and
 *  the line-based parsers downstream have nothing to work with. */
function itemsToLines(items: TextItemLike[]): string[] {
  const rows = new Map<number, Array<{ x: number; str: string }>>();

  for (const item of items) {
    if (!item.str) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    // Round to the nearest couple of points: characters on one visual line
    // rarely share an exact y, especially with mixed font sizes.
    const key = Math.round(y / 2) * 2;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key)!.push({ x, str: item.str });
  }

  return [...rows.entries()]
    // PDF y grows upward, so descending y is top-to-bottom reading order.
    .sort((a, b) => b[0] - a[0])
    .map(([, fragments]) =>
      fragments
        .sort((a, b) => a.x - b.x)
        .map((f) => f.str)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

let workerConfigured = false;

/** pdf.js parses in a worker and needs to be told where its worker file is.
 *
 *  Vite's `?url` import is the only form that resolves a bare package
 *  specifier to an emitted asset — `new URL('pdfjs-dist/...', import.meta.url)`
 *  resolves relative to *this file's* directory instead, producing a path
 *  that does not exist.
 *
 *  Skipped entirely outside a browser (the test run), where pdf.js's own
 *  default resolution finds the worker through node_modules and setting it
 *  by hand only breaks that. */
async function configureWorker(pdfjs: { GlobalWorkerOptions: { workerSrc: string } }): Promise<void> {
  if (workerConfigured || typeof window === 'undefined') return;
  workerConfigured = true;
  const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfExtraction> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  await configureWorker(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } });

  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const lines = itemsToLines(content.items as unknown as TextItemLike[]);
    if (lines.length) pages.push(lines.join('\n'));
  }

  const text = pages.join('\n\n').trim();
  await doc.destroy();

  // Both conditions matter and neither alone is enough. A scanned page
  // yields one or two stray fragments — a page number, a watermark — so a
  // line count separates it from a real text layer; but a short recipe is
  // only a few dozen characters, so a character threshold high enough to
  // exclude a watermark on its own would reject genuine recipes too.
  const lineCount = text.split('\n').filter((l) => l.trim()).length;
  const density = text.replace(/\s/g, '').length;

  return {
    text,
    pageCount: doc.numPages,
    hasTextLayer: lineCount >= 3 && density >= 40,
  };
}
