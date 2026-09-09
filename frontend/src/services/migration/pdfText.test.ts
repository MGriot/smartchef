// Built against a real PDF rather than a mocked pdf.js: the whole point of
// this module is that it copes with how PDFs actually store text — as
// positioned fragments with no notion of a line — so mocking the library
// would test nothing that matters.

import { describe, it, expect } from 'vitest';
import { extractPdfText } from './pdfText';

/** A minimal, spec-valid PDF with one page of text lines, with a correctly
 *  computed xref table so pdf.js parses it the normal way rather than
 *  falling back to its recovery path. */
function makePdf(lines: Array<{ text: string; y: number }>): Uint8Array {
  const content = lines
    .map((l) => `BT /F1 12 Tf 72 ${l.y} Td (${l.text.replace(/([()\\])/g, '\\$1')}) Tj ET`)
    .join('\n');

  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

describe('extractPdfText', () => {
  it('reads the text layer of a real PDF', async () => {
    const pdf = makePdf([
      { text: 'Pasta al pomodoro', y: 720 },
      { text: 'Ingredients:', y: 700 },
      { text: '400 g spaghetti', y: 685 },
      { text: '500 g tomatoes', y: 670 },
    ]);

    const result = await extractPdfText(pdf);
    expect(result.pageCount).toBe(1);
    expect(result.hasTextLayer).toBe(true);
    expect(result.text).toContain('Pasta al pomodoro');
    expect(result.text).toContain('400 g spaghetti');
  });

  it('rebuilds lines top to bottom, not in PDF coordinate order', async () => {
    // PDF y grows upward, so the first line has the *highest* y. Emitting
    // the objects bottom-up here proves the ordering is by coordinate and
    // not by the order fragments happen to appear in the file.
    const pdf = makePdf([
      { text: 'Third line', y: 670 },
      { text: 'First line', y: 720 },
      { text: 'Second line', y: 700 },
    ]);

    const lines = (await extractPdfText(pdf)).text.split('\n').filter(Boolean);
    expect(lines).toEqual(['First line', 'Second line', 'Third line']);
  });

  it('keeps ingredient lines separate rather than running them together', async () => {
    // The failure this module's line-grouping exists to prevent: without
    // it every ingredient arrives as one paragraph and the line-based
    // parsers downstream have nothing to split on.
    const pdf = makePdf([
      { text: '200 g flour', y: 700 },
      { text: '2 eggs', y: 685 },
      { text: '1 tsp salt', y: 670 },
    ]);
    const lines = (await extractPdfText(pdf)).text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('2 eggs');
  });

  it('reports a scanned page as having no text layer', async () => {
    // A cookbook photographed into a PDF has images and maybe a page
    // number — importing that as a recipe would produce nothing useful, so
    // the caller needs to know to try OCR instead.
    const pdf = makePdf([{ text: '12', y: 60 }]);
    const result = await extractPdfText(pdf);
    expect(result.hasTextLayer).toBe(false);
  });
});
