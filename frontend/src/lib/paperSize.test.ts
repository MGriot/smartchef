import { describe, it, expect } from 'vitest';
import { contentSize, defaultPaperSize, pageRule, sheetSize } from './paperSize';

describe('paperSize', () => {
  it('defaults to Letter only for US/CA English and US/MX Spanish', () => {
    expect(defaultPaperSize('en-US')).toBe('Letter');
    expect(defaultPaperSize('en-CA')).toBe('Letter');
    expect(defaultPaperSize('es-MX')).toBe('Letter');
    expect(defaultPaperSize('en-GB')).toBe('A4');
    expect(defaultPaperSize('it-IT')).toBe('A4');
    expect(defaultPaperSize('en')).toBe('A4');
  });

  it('swaps width and height in landscape', () => {
    expect(sheetSize('A4')).toEqual({ width: 210, height: 297 });
    expect(sheetSize('A4', 'landscape')).toEqual({ width: 297, height: 210 });
    expect(sheetSize('Letter', 'landscape').width).toBeCloseTo(279.4);
  });

  it('takes the margins off both sides of the content area', () => {
    expect(contentSize('A4')).toEqual({ width: 182, height: 269 });
  });

  it('writes the @page rule', () => {
    expect(pageRule('A4')).toBe('@page { size: A4 portrait; margin: 14mm; }');
    expect(pageRule('Letter', 'landscape')).toBe('@page { size: Letter landscape; margin: 14mm; }');
  });
});
