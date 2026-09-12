import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ImageFs } from './localImages';

// db/local.ts reaches for @capacitor-community/sqlite at import time, which
// has no implementation under vitest. Backed by a tiny in-memory table store
// instead — enough to exercise the SELECT/UPDATE shapes this module actually
// issues, which is what the migration's correctness turns on.
const tables: Record<string, Array<Record<string, string | null>>> = {};

/** Mirrors the LIKE pattern the module issues, so the fake store filters rows
 *  the same way real SQLite would. */
const BASE64_URI = /^data:image\/[a-z0-9.+-]*;base64,/i;

vi.mock('../db/local', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    const select = /SELECT id, (\w+) AS value FROM (\w+) WHERE \w+ LIKE 'data:image\/%;base64,%'/.exec(sql);
    if (select) {
      const [, column, table] = select;
      return (tables[table] ?? [])
        .filter((row) => typeof row[column] === 'string' && BASE64_URI.test(row[column]!))
        .map((row) => ({ id: row.id, value: row[column] }));
    }
    const probe = /SELECT id FROM (\w+) WHERE (\w+) LIKE 'data:image\/%;base64,%' LIMIT 1/.exec(sql);
    if (probe) {
      const [, table, column] = probe;
      const hit = (tables[table] ?? []).find((row) => typeof row[column] === 'string' && BASE64_URI.test(row[column]!));
      return hit ? [{ id: hit.id }] : [];
    }
    const update = /UPDATE (\w+) SET (\w+) = \$1 WHERE id = \$2/.exec(sql);
    if (update) {
      const [, table, column] = update;
      const row = (tables[table] ?? []).find((r) => r.id === params[1]);
      if (row) row[column] = params[0] as string;
      return [];
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  },
}));

const { migrateInlineImages, hasInlineImages } = await import('./inlineImageMigration');

function createFakeImageFs() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async exists(p: string) { return files.has(p); },
    async readFile(p: string) {
      const bytes = files.get(p);
      if (!bytes) throw new Error(`ENOENT: '${p}'`);
      return bytes;
    },
    async writeFile(p: string, data: Uint8Array) { files.set(p, data); },
    async list() { return [...files.keys()]; },
  };
}

/** A real, decodable data: URI — base64 of the given text. */
function dataUri(text: string, mime = 'image/webp'): string {
  return `data:${mime};base64,${btoa(text)}`;
}

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  tables.recipes = [];
  tables.recipe_steps = [];
  tables.profiles = [];
});

describe('hasInlineImages', () => {
  it('is false for a library whose images are all paths or URLs', async () => {
    tables.recipes = [
      { id: 'r1', cover_image_url: 'images/abc123.jpg' },
      { id: 'r2', cover_image_url: 'https://example.com/photo.jpg' },
      { id: 'r3', cover_image_url: null },
    ];
    expect(await hasInlineImages()).toBe(false);
  });

  it('is true as soon as one row holds an inline image', async () => {
    tables.recipe_steps = [{ id: 's1', image_url: dataUri('step photo') }];
    expect(await hasInlineImages()).toBe(true);
  });
});

describe('migrateInlineImages', () => {
  it('moves an inline cover into the store and rewrites the column to its path', async () => {
    tables.recipes = [{ id: 'r1', cover_image_url: dataUri('focaccia photo') }];
    const fs = createFakeImageFs();

    const result = await migrateInlineImages(fs as unknown as ImageFs);

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);
    const stored = tables.recipes[0].cover_image_url!;
    expect(stored).toMatch(/^images\/[0-9a-f]{64}\.webp$/);
    expect(new TextDecoder().decode(fs.files.get(stored)!)).toBe('focaccia photo');
  });

  it('covers every image-bearing column, not just recipe covers', async () => {
    tables.recipes = [{ id: 'r1', cover_image_url: dataUri('cover') }];
    tables.recipe_steps = [{ id: 's1', image_url: dataUri('step') }];
    tables.profiles = [{ id: 'p1', avatar_url: dataUri('avatar') }];
    const fs = createFakeImageFs();

    const result = await migrateInlineImages(fs as unknown as ImageFs);

    expect(result.migrated).toBe(3);
    expect(tables.recipes[0].cover_image_url).toMatch(/^images\//);
    expect(tables.recipe_steps[0].image_url).toMatch(/^images\//);
    expect(tables.profiles[0].avatar_url).toMatch(/^images\//);
  });

  it('leaves URLs, stored paths and nulls exactly as they are', async () => {
    tables.recipes = [
      { id: 'r1', cover_image_url: 'https://example.com/a.jpg' },
      { id: 'r2', cover_image_url: 'images/already.jpg' },
      { id: 'r3', cover_image_url: null },
    ];
    const fs = createFakeImageFs();

    const result = await migrateInlineImages(fs as unknown as ImageFs);

    expect(result.migrated).toBe(0);
    expect(fs.files.size).toBe(0);
    expect(tables.recipes.map((r) => r.cover_image_url)).toEqual([
      'https://example.com/a.jpg', 'images/already.jpg', null,
    ]);
  });

  it('dedups two rows sharing the same image down to one stored file', async () => {
    const same = dataUri('identical bytes');
    tables.recipes = [
      { id: 'r1', cover_image_url: same },
      { id: 'r2', cover_image_url: same },
    ];
    const fs = createFakeImageFs();

    await migrateInlineImages(fs as unknown as ImageFs);

    expect(fs.files.size).toBe(1);
    expect(tables.recipes[0].cover_image_url).toBe(tables.recipes[1].cover_image_url);
  });

  it('leaves a row untouched when its image cannot be stored, and keeps going', async () => {
    tables.recipes = [
      { id: 'bad', cover_image_url: 'data:image/webp;base64,!!!not base64!!!' },
      { id: 'good', cover_image_url: dataUri('fine') },
    ];
    const fs = createFakeImageFs();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await migrateInlineImages(fs as unknown as ImageFs);

    expect(result.failed).toBe(1);
    expect(result.migrated).toBe(1);
    // The unconvertible row still holds a working (if bloated) image rather
    // than a dangling path — losing the photo would be far worse than
    // leaving it inline for another attempt next launch.
    expect(tables.recipes[0].cover_image_url).toMatch(/^data:/);
    expect(tables.recipes[1].cover_image_url).toMatch(/^images\//);
  });

  it('never rewrites the column when the stored file cannot be read back', async () => {
    tables.recipes = [{ id: 'r1', cover_image_url: dataUri('photo') }];
    const fs = createFakeImageFs();
    // A write that silently truncates — the exact failure the read-back
    // verification exists to catch before the only other copy is dropped.
    vi.spyOn(fs, 'writeFile').mockImplementation(async (p: string) => {
      fs.files.set(p, new Uint8Array(0));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await migrateInlineImages(fs as unknown as ImageFs);

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);
    expect(tables.recipes[0].cover_image_url).toMatch(/^data:/);
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    tables.recipes = [{ id: 'r1', cover_image_url: dataUri('photo') }];
    const fs = createFakeImageFs();

    await migrateInlineImages(fs as unknown as ImageFs);
    const second = await migrateInlineImages(fs as unknown as ImageFs);

    expect(second).toEqual({ migrated: 0, failed: 0, bytesFreed: 0 });
    expect(await hasInlineImages()).toBe(false);
  });

  it('reports how much text it removed from the database', async () => {
    const uri = dataUri('a'.repeat(3000));
    tables.recipes = [{ id: 'r1', cover_image_url: uri }];

    const result = await migrateInlineImages(createFakeImageFs() as unknown as ImageFs);

    const storedPathLength = tables.recipes[0].cover_image_url!.length;
    expect(result.bytesFreed).toBe(uri.length - storedPathLength);
  });
});

describe('percent-encoded SVG avatars', () => {
  // Found running the migration against a real library: generated profile
  // avatars are stored as `data:image/svg+xml,%3csvg…` — a `data:` URI, but
  // markup rather than a base64 photo, and a few hundred bytes rather than
  // hundreds of kilobytes. Converting it would gain nothing; *attempting* to
  // convert it would fail and log on every single launch, forever.
  const SVG_AVATAR = "data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%3e%3c/svg%3e";

  it('are not treated as migration candidates', async () => {
    tables.profiles = [{ id: 'p1', avatar_url: SVG_AVATAR }];
    expect(await hasInlineImages()).toBe(false);
  });

  it('are left untouched, with nothing reported as failed', async () => {
    tables.profiles = [{ id: 'p1', avatar_url: SVG_AVATAR }];
    const fs = createFakeImageFs();

    const result = await migrateInlineImages(fs as unknown as ImageFs);

    expect(result).toEqual({ migrated: 0, failed: 0, bytesFreed: 0 });
    expect(tables.profiles[0].avatar_url).toBe(SVG_AVATAR);
    expect(fs.files.size).toBe(0);
  });
});
