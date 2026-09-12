// ════════════════════════════════════════════════════════════════════════
// SmartChef — Image replication between Local Storage and the Hidden Clone
//
// ADR 0003 decided that the Hidden Clone (and therefore the Sync Folder)
// carries full-resolution copies of Local Storage's images. The decision was
// recorded; the code was never written — gitSync.ts's ALL_ENTITY_DIRS only
// ever listed the JSON entity directories, and a Hidden Clone on disk had no
// `images/` folder at all. This module is that missing half.
//
// Why it can be this simple: image paths are content-addressed
// (`images/<sha256>.<ext>`, see lib/localImages.ts), so a given path's bytes
// are the same on every device, forever. Two devices can never disagree
// about what `images/ab12….jpg` contains, which means replication is
// add-only and no merge, conflict detection or ordering rule is needed —
// unlike the JSON entity files, which genuinely can diverge and go through
// mergeBridge.ts's Structured Merge. That is also exactly why `images` must
// NOT be added to mergeBridge.ts's ENTITY_DIRS: it would try to parse a JPEG
// as an entity record.
//
// Copying (rather than moving or symlinking) is deliberate: Local Storage is
// what every screen reads, the Hidden Clone is what git commits, and neither
// may depend on the other existing. The cost is disk, which ADR 0003 already
// accepted and priced.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import { gitfs } from '../gitfs';
import { defaultImageFs, IMAGES_SUBDIR, type ImageFs } from '../localImages';

/** How many files to copy before yielding back to the event loop. Both
 *  directions run on the main thread, and on Android every single read and
 *  write is a Capacitor bridge round-trip — a first sync against a library
 *  with hundreds of photos would otherwise hold the UI thread for the whole
 *  batch. */
const YIELD_EVERY = 8;

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface ImageReplicationResult {
  copied: number;
  /** Files that could not be copied. Never fatal — a missing image degrades
   *  to the placeholder the UI already draws for "no cover", and the next
   *  sync retries. */
  failed: number;
}

/** Lists `images/*` inside the Hidden Clone. Returns an empty list when the
 *  folder isn't there yet, which is the normal state for a clone created
 *  before this module existed. */
async function listCloneImages(dir: string): Promise<string[]> {
  try {
    const names = await gitfs.promises.readdir(`${dir}/${IMAGES_SUBDIR}`);
    return names.map((name) => `${IMAGES_SUBDIR}/${name}`);
  } catch {
    return [];
  }
}

/** Local Storage → Hidden Clone. Run before staging a commit so this
 *  device's own new photos become part of the history it pushes.
 *
 *  Only copies what the clone doesn't already have. Since the path encodes
 *  the content, "already has this path" is a complete answer — there is no
 *  such thing as a stale copy to refresh. */
export async function copyImagesIntoClone(dir: string, fs: ImageFs = defaultImageFs()): Promise<ImageReplicationResult> {
  const result: ImageReplicationResult = { copied: 0, failed: 0 };

  let stored: string[];
  try {
    stored = await fs.list();
  } catch (err) {
    console.error('SmartChef: could not list local images for sync:', err);
    return result;
  }
  if (stored.length === 0) return result;

  // One readdir of the clone beats one stat per image — on Android that is
  // the difference between 1 bridge call and N.
  const alreadyThere = new Set(await listCloneImages(dir));

  let since = 0;
  for (const relPath of stored) {
    if (alreadyThere.has(relPath)) continue;
    try {
      const bytes = await fs.readFile(relPath);
      await gitfs.promises.writeFile(`${dir}/${relPath}`, bytes);
      result.copied++;
    } catch (err) {
      console.error(`SmartChef: could not copy ${relPath} into the sync clone:`, err);
      result.failed++;
    }
    if (++since >= YIELD_EVERY) {
      since = 0;
      await yieldToUi();
    }
  }

  return result;
}

/** Hidden Clone → Local Storage. Run after a merge/checkout has brought
 *  another device's commits into the working tree, so the images those
 *  commits reference are actually readable by the screens that render them.
 *
 *  Without this, a recipe synced from another device would arrive with a
 *  perfectly valid `images/<hash>` cover path pointing at a file this device
 *  does not have — which is precisely the regression that made replicating
 *  images a prerequisite for moving inline `data:` URIs out of the database
 *  (see lib/inlineImageMigration.ts). */
export async function copyImagesOutOfClone(dir: string, fs: ImageFs = defaultImageFs()): Promise<ImageReplicationResult> {
  const result: ImageReplicationResult = { copied: 0, failed: 0 };

  const inClone = await listCloneImages(dir);
  if (inClone.length === 0) return result;

  const alreadyLocal = new Set(await fs.list().catch(() => []));

  let since = 0;
  for (const relPath of inClone) {
    if (alreadyLocal.has(relPath)) continue;
    try {
      const bytes = await gitfs.promises.readFile(`${dir}/${relPath}`);
      // gitfs's readFile returns a string when asked for utf8; it isn't
      // here, so this is always the byte path.
      await fs.writeFile(relPath, bytes as Uint8Array);
      result.copied++;
    } catch (err) {
      console.error(`SmartChef: could not copy ${relPath} out of the sync clone:`, err);
      result.failed++;
    }
    if (++since >= YIELD_EVERY) {
      since = 0;
      await yieldToUi();
    }
  }

  return result;
}

/** Materializes every `images/*` file a merged remote commit carries into
 *  both the Hidden Clone's working tree and Local Storage.
 *
 *  Needed because mergeRemoteIntoLocal() never checks the remote tree out —
 *  it reads the entity blobs it cares about and writes those JSON files by
 *  hand. Images fetched from another device therefore arrive as git objects
 *  that nothing ever puts on disk, so a synced recipe would reference a
 *  cover this device technically has and still cannot open. This is the step
 *  that closes that gap.
 *
 *  Skips anything already present, so it is cheap on every cycle after the
 *  one that first brought a given photo across, and safe to re-run. */
export async function materializeImagesFromCommit(
  dir: string,
  gitdir: string,
  oid: string,
  fs: ImageFs = defaultImageFs()
): Promise<ImageReplicationResult> {
  const result: ImageReplicationResult = { copied: 0, failed: 0 };

  let files: string[];
  try {
    files = await git.listFiles({ fs: gitfs, dir, gitdir, ref: oid });
  } catch (err) {
    console.error('SmartChef: could not list files in the merged commit for image sync:', err);
    return result;
  }

  const imagePaths = files.filter((f) => f.startsWith(`${IMAGES_SUBDIR}/`));
  if (imagePaths.length === 0) return result;

  const alreadyLocal = new Set(await fs.list().catch(() => []));
  const alreadyInClone = new Set(await listCloneImages(dir));

  let since = 0;
  for (const relPath of imagePaths) {
    const needsLocal = !alreadyLocal.has(relPath);
    const needsClone = !alreadyInClone.has(relPath);
    if (!needsLocal && !needsClone) continue;

    try {
      const { blob } = await git.readBlob({ fs: gitfs, dir, gitdir, oid, filepath: relPath });
      if (needsClone) await gitfs.promises.writeFile(`${dir}/${relPath}`, blob);
      if (needsLocal) await fs.writeFile(relPath, blob);
      result.copied++;
    } catch (err) {
      // A blob the fetch didn't bring across, or a write that failed. The
      // recipe still syncs; only its photo is missing, and the next cycle
      // tries again.
      console.error(`SmartChef: could not materialize ${relPath} from the merged commit:`, err);
      result.failed++;
    }

    if (++since >= YIELD_EVERY) {
      since = 0;
      await yieldToUi();
    }
  }

  return result;
}
