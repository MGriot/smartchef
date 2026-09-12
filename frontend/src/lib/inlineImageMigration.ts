// ════════════════════════════════════════════════════════════════════════
// SmartChef — Inline `data:` image migration (standalone mode)
//
// Some rows carry a whole image base64-encoded into the column that is meant
// to hold a *reference* to one. Restoring a with-images backup is how they
// got there (backup.local.ts passed coverImageUrl/imageUrl through verbatim,
// and the export format embeds images); the import path never allowed it —
// pageFetcher.ts's absoluteImageUrl() turns `data:` away on purpose, with a
// comment saying exactly why.
//
// Why this matters far more on Android than on Electron: every one of those
// bytes is dragged back out on every read, and in standalone mode a read
// crosses the Capacitor bridge, where the whole result set is JSON-stringified
// in Java and re-parsed in the WebView. Measured on a real library
// (docs/plans/2026-09-12-android-performance-plan.md): 630 KB of base64 in
// `recipes.cover_image_url` made the gallery's list query move 689 KB instead
// of ~26 KB, and 1.07 MB in `recipe_steps.image_url` meant one recipe alone
// dragged 655 KB of step photos every time it was opened.
//
// The fix is not to delete anything — it is to put the image where the app
// already has a proper home for it: lib/localImages.ts's content-addressed
// store (`images/<sha256>.<ext>`, deduped), leaving a ~40-character path in
// the column. Same image, same display path (useResolvedImageSrc() already
// resolves that shape), a fraction of the cost.
// ════════════════════════════════════════════════════════════════════════

import { query } from '../db/local';
import { decodeDataUri, isInlineDataUri, storeImage, readImage, type ImageFs } from './localImages';

/** One column that can hold an image reference, and how to address its rows. */
interface ImageColumn {
  table: string;
  column: string;
}

// Every column an image reference can currently live in. A column added
// later only needs a line here. `techniques.image_urls` and friends are
// JSON arrays rather than single references and hold no inline data today —
// left out deliberately rather than forgotten; add them with their own
// array-aware handling if that ever changes.
const IMAGE_COLUMNS: ImageColumn[] = [
  { table: 'recipes', column: 'cover_image_url' },
  { table: 'recipe_steps', column: 'image_url' },
  { table: 'profiles', column: 'avatar_url' },
];

export interface InlineImageMigrationResult {
  /** Rows whose inline image is now a content-addressed path. */
  migrated: number;
  /** Rows left exactly as they were because converting them failed. */
  failed: number;
  /** Bytes of base64 text removed from the database. */
  bytesFreed: number;
}

// The SQL counterpart to isInlineDataUri(). Kept as a LIKE pattern rather
// than pulling every `data:` row into JS to filter, so a percent-encoded SVG
// avatar is never even read — matching it would mean re-scanning, failing and
// logging on every launch for a value that is a few hundred bytes and
// correct as it stands.
const INLINE_BASE64_LIKE = "'data:image/%;base64,%'";

/** True if any row anywhere still holds an inline base64 image. Cheap enough
 *  to call on every launch: three `LIKE … LIMIT 1` probes against small
 *  tables, which stop at the first match. */
export async function hasInlineImages(): Promise<boolean> {
  for (const { table, column } of IMAGE_COLUMNS) {
    const rows = await query<{ id: string }>(
      `SELECT id FROM ${table} WHERE ${column} LIKE ${INLINE_BASE64_LIKE} LIMIT 1`
    );
    if (rows.length > 0) return true;
  }
  return false;
}

/** Moves every inline `data:` image into the content-addressed store and
 *  rewrites its column to the resulting path.
 *
 *  Safe to interrupt and safe to re-run. Each row is converted
 *  independently, and the column is only rewritten *after* the bytes are
 *  confirmed readable back out of the store — so a crash, a full disk or a
 *  single malformed URI can never turn an image into a dangling path. A row
 *  that fails is left holding its original data URI and retried on the next
 *  run; it never blocks the rest.
 *
 *  `fs` is injectable purely so the tests can exercise the real logic
 *  against an in-memory store, matching localImages.test.ts's own pattern. */
export async function migrateInlineImages(fs?: ImageFs): Promise<InlineImageMigrationResult> {
  const result: InlineImageMigrationResult = { migrated: 0, failed: 0, bytesFreed: 0 };

  for (const { table, column } of IMAGE_COLUMNS) {
    // Read ids and values one column at a time rather than all at once: the
    // whole point of this migration is that these values are large, so
    // holding every one of them in memory simultaneously is the exact cost
    // being removed.
    const rows = await query<{ id: string; value: string }>(
      `SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE ${INLINE_BASE64_LIKE}`
    );

    for (const row of rows) {
      if (!isInlineDataUri(row.value)) continue; // defensive: LIKE is looser than the real check
      try {
        const { bytes, extHint } = decodeDataUri(row.value);
        const relPath = await storeImage(bytes, extHint, fs);

        // Prove the store can serve it before the only other copy is
        // overwritten. storeImage() skips the write when the file already
        // exists (dedup), so this also catches the case where a previous
        // run wrote a truncated file.
        const readBack = await readImage(relPath, fs);
        if (readBack.length !== bytes.length) {
          throw new Error(`stored image read back as ${readBack.length} bytes, expected ${bytes.length}`);
        }

        await query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [relPath, row.id]);
        result.migrated++;
        result.bytesFreed += row.value.length - relPath.length;
      } catch (err) {
        // Deliberately non-fatal, and deliberately loud. The row keeps its
        // working (if bloated) image; the next launch tries again.
        console.error(`SmartChef: could not migrate inline image in ${table}.${column} row ${row.id}:`, err);
        result.failed++;
      }
    }
  }

  return result;
}

/** Runs the migration only if there is anything to do, and never lets a
 *  failure propagate — this is an optimization, not a correctness
 *  requirement, so it must not be able to break a launch. Intended to be
 *  fired after first paint (see App.tsx), not awaited during startup. */
export async function migrateInlineImagesIfNeeded(): Promise<void> {
  try {
    if (!(await hasInlineImages())) return;
    const { migrated, failed, bytesFreed } = await migrateInlineImages();
    if (migrated > 0) {
      console.info(
        `SmartChef: moved ${migrated} inline image(s) into local image storage, ` +
        `freeing ${(bytesFreed / 1024).toFixed(0)} KB from the database` +
        (failed > 0 ? ` (${failed} could not be converted and were left untouched)` : '')
      );
    }
  } catch (err) {
    console.error('SmartChef: inline image migration failed:', err);
  }
}
