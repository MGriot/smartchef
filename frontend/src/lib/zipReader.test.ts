// Built against real archives rather than hand-written byte fixtures: the
// zips are produced here with Node's own zlib, so the reader is tested
// against the same bytes a real Paprika or Mela export contains, including
// both STORED and DEFLATE entries in one file.

import { describe, it, expect } from 'vitest';
import { deflateRawSync, gzipSync, crc32 } from 'node:zlib';
import { readZip, gunzip, looksZipped, looksGzipped } from './zipReader';

interface FileSpec { name: string; content: Uint8Array; store?: boolean }

/** A real, spec-shaped zip: local headers, central directory, EOCD. */
function makeZip(files: FileSpec[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const stored = !!file.store;
    const data = stored ? file.content : new Uint8Array(deflateRawSync(file.content));
    const crc = crc32(Buffer.from(file.content));

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, stored ? 0 : 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, file.content.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, stored ? 0 : 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, file.content.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('signature sniffing', () => {
  it('recognises zip and gzip headers', () => {
    expect(looksZipped(makeZip([{ name: 'a.txt', content: enc.encode('hi') }]))).toBe(true);
    expect(looksGzipped(new Uint8Array(gzipSync(Buffer.from('hi'))))).toBe(true);
    expect(looksZipped(enc.encode('{"not":"a zip"}'))).toBe(false);
    expect(looksGzipped(enc.encode('{}'))).toBe(false);
  });
});

describe('readZip', () => {
  it('reads deflated entries', async () => {
    const body = JSON.stringify({ name: 'Pasta', ingredients: 'a'.repeat(500) });
    const zip = makeZip([{ name: 'recipe.json', content: enc.encode(body) }]);
    const entries = await readZip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('recipe.json');
    expect(dec.decode(entries[0].bytes)).toBe(body);
  });

  it('reads stored (uncompressed) entries', async () => {
    // Small files are often stored rather than deflated; both appear in one
    // real export.
    const zip = makeZip([{ name: 'small.txt', content: enc.encode('hi'), store: true }]);
    const entries = await readZip(zip);
    expect(dec.decode(entries[0].bytes)).toBe('hi');
  });

  it('reads a mixed archive, in order', async () => {
    const zip = makeZip([
      { name: 'one.json', content: enc.encode('{"n":1}'), store: true },
      { name: 'two.json', content: enc.encode(JSON.stringify({ n: 2, pad: 'x'.repeat(300) })) },
      { name: 'three.json', content: enc.encode('{"n":3}') },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['one.json', 'two.json', 'three.json']);
    expect(JSON.parse(dec.decode(entries[1].bytes)).n).toBe(2);
  });

  it('skips directory entries', async () => {
    const zip = makeZip([
      { name: 'recipes/', content: new Uint8Array(0), store: true },
      { name: 'recipes/a.json', content: enc.encode('{}'), store: true },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['recipes/a.json']);
  });

  it('handles unicode filenames', async () => {
    const zip = makeZip([{ name: 'Pollo al limón & café.json', content: enc.encode('{}'), store: true }]);
    expect((await readZip(zip))[0].name).toBe('Pollo al limón & café.json');
  });

  it('accepts an ArrayBuffer as well as a view', async () => {
    const zip = makeZip([{ name: 'a.json', content: enc.encode('{"ok":true}'), store: true }]);
    const entries = await readZip(zip.buffer.slice(0) as ArrayBuffer);
    expect(dec.decode(entries[0].bytes)).toBe('{"ok":true}');
  });

  it('fails clearly on something that is not a zip', async () => {
    await expect(readZip(enc.encode('this is plainly not a zip file at all'))).rejects.toThrow(/not a zip/i);
  });
});

describe('gunzip', () => {
  it('reads a gzip member, which is what Paprika puts inside its zip', async () => {
    const body = JSON.stringify({ name: 'Ragù', servings: '4' });
    const out = await gunzip(new Uint8Array(gzipSync(Buffer.from(body))));
    expect(dec.decode(out)).toBe(body);
  });
});
