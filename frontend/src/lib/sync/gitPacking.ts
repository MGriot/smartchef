// ════════════════════════════════════════════════════════════════════════
// SmartChef — Local object packing (a git-gc equivalent) for the Hidden
// Clone, addressing the Android performance plan's item #2
// (docs/plans/2026-08-22-android-performance-plan.md).
//
// gitObjectTransport.ts and gitBundleTransport.ts both document this
// design's original stance as "never packs or garbage-collects" — every
// commit/add only ever produces loose objects (.git/objects/<xx>/<rest>),
// one file per object, forever. That was a deliberate simplification, not
// an accident, but it has a real cost: Android's Filesystem plugin bridge
// has genuine per-call latency, so a library with a long edit history
// accumulates thousands of tiny loose files, and every local git operation
// that has to stat/read them one at a time (commit, merge, checkout,
// findMergeBase, ...) gets slower as that count grows.
//
// isomorphic-git already reads packed objects transparently everywhere
// (its readObjectPacked() checks .git/objects/pack/*.idx whenever a loose
// read comes up empty — confirmed by reading its own source, not assumed),
// so packing loose objects into one file is a pure local read-speed win
// with NO changes needed at any of isomorphic-git's own call sites
// (commit/merge/checkout/... keep working exactly as before). The only
// genuinely new risk is on the WRITE side of THIS module: pruning
// (deleting) a loose file after packing it must never lose data.
//
// Deliberate scope boundary — read before changing the "safe to prune"
// rule below: this module only ever packs+prunes objects the caller has
// already confirmed are durably on the remote (see
// packLooseObjectsAfterPush()'s own docstring). It does NOT make
// gitObjectTransport.ts's push or gitBundleTransport.ts's bundle
// pack-aware — both still only enumerate LOOSE objects via
// listLocalObjectPaths(), same as before this module existed. That means
// an object this module has pruned can no longer be re-offered by THIS
// device if the remote somehow lost it independently, or bundled by THIS
// device for another device's catch-up. Accepted deliberately rather than
// building a pack-aware enumeration (which would need either a new
// sidecar manifest or parsing isomorphic-git's internal .idx format,
// neither exposed as a public API) because the exposure is narrow and
// already has precedent: gitBundleTransport.ts's own docstring already
// documents that a device's bundle is best-effort, not exhaustive, for
// the exact same reason (objects that device itself only ever received
// via a prior bundle catch-up were already excluded from its own loose
// set, and therefore from any bundle it writes). This module's pruning is
// one more instance of that same, already-accepted shape — not a new
// category of risk — and the day-to-day, primary sync path (direct
// object-by-object pull from the remote's own loose storage, populated by
// every device's past pushes before any local pruning ever happened) is
// completely unaffected either way.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import type { GitPlumbingFs } from './gitObjectTransport';
import { listLocalObjectPaths, oidFromObjectPath, sha1Hex, mapWithConcurrency, TRANSFER_CONCURRENCY } from './gitObjectTransport';

// Packing/verifying/pruning all cost real I/O — not worth paying for a
// handful of objects. Below this, packLooseObjectsAfterPush() is a no-op;
// it naturally re-triggers once enough new loose objects accumulate since
// the last run (each run only ever packs what's CURRENTLY loose — see the
// module header — so this isn't a one-time threshold, it's a recurring
// gate every time this function is called).
const GC_MIN_LOOSE_OBJECTS = 200;

const QUARANTINE_DIR = '.git/objects/.gc-quarantine';

function quarantineFilename(relativePath: string): string {
  // .git/objects/xx/yyyy... -> xx-yyyy...  (flattened so every quarantined
  // object lands directly in QUARANTINE_DIR with no further subdirectories
  // to create/clean up).
  return relativePath.replace(/^\.git\/objects\//, '').replace('/', '-');
}

async function existsLocally(fs: GitPlumbingFs, dir: string, relativePath: string): Promise<boolean> {
  try {
    await fs.stat(`${dir}/${relativePath}`);
    return true;
  } catch {
    return false;
  }
}

export interface GcResult {
  /** 0 whenever nothing ran — below GC_MIN_LOOSE_OBJECTS, or packObjects()
   *  produced nothing (no commits yet). Not an error either way. */
  packed: number;
}

/** Packs every CURRENTLY loose object in this Hidden Clone into one
 *  packfile, verifies the pack genuinely serves each of them, then deletes
 *  the now-redundant loose originals. Safe to call after ANY successful
 *  sync-cycle push (folder mode's pushObjectsAndRefs() having returned
 *  without throwing, or git-remote mode's pushGitRemote() having returned
 *  `pushed: true`) — both mean every object this device had loose at that
 *  moment is now durably on the remote too, so pruning the local loose
 *  copy afterward loses no data: the content still exists (remote, and
 *  locally inside the new pack), only the redundant loose duplicate goes
 *  away.
 *
 *  MUST be called from inside gitSync.ts's serialize() queue (the same
 *  mutex every other Hidden Clone mutation already goes through) — this
 *  function takes an unguarded, un-atomic snapshot of "what's loose right
 *  now" via listLocalObjectPaths() and assumes nothing else can add a NEW
 *  loose object while it runs (which would be fine, just left unpacked
 *  for next time) or, worse, touch the exact files it's mid-quarantining.
 *  Every existing call site (commitNow, syncNow) already funnels through
 *  that same queue for this exact reason.
 *
 *  Never throws on a verification failure — restores every quarantined
 *  file and returns { packed: 0 } instead, so a corrupt/incomplete pack
 *  never costs a single byte of real data. DOES let a genuine I/O error
 *  (disk full while writing the pack, etc.) propagate, same as every
 *  other best-effort step in gitSync.ts's sync cycle — callers wrap this
 *  in a catch, matching writeBundleIfStale()'s existing pattern, since a
 *  packing failure must never fail the sync itself. */
export async function packLooseObjectsAfterPush(fs: GitPlumbingFs, dir: string, gitdir: string): Promise<GcResult> {
  const loosePaths = await listLocalObjectPaths(fs, dir);
  if (loosePaths.length < GC_MIN_LOOSE_OBJECTS) return { packed: 0 };

  const oids = loosePaths.map(oidFromObjectPath);
  const { packfile } = await git.packObjects({ fs: { promises: fs }, dir, gitdir, oids, write: false });
  if (!packfile || packfile.length === 0) return { packed: 0 };

  const packHash = await sha1Hex(packfile);
  const packFilepath = `.git/objects/pack/pack-gc-${packHash}.pack`;
  if (!(await existsLocally(fs, dir, packFilepath))) {
    await fs.writeFile(`${dir}/${packFilepath}`, packfile);
    await git.indexPack({ fs: { promises: fs }, dir, gitdir, filepath: packFilepath });
  }
  // If the pack already existed, fall through to verify+prune anyway —
  // covers a previous run that built the pack but crashed (or the app was
  // killed) before finishing pruning, so this call picks up where it left
  // off instead of silently doing nothing.

  await fs.mkdir(`${dir}/${QUARANTINE_DIR}`).catch(() => {}); // EEXIST from a prior run — fine

  // Every step below is one Android Filesystem-plugin round-trip per
  // object — run with the same bounded concurrency push/pull already use
  // (gitObjectTransport.ts's mapWithConcurrency/TRANSFER_CONCURRENCY) for
  // the identical reason: hundreds of these done one at a time in series
  // made a device's first GC pass (potentially years of accumulated
  // history) visibly slow a whole sync cycle, the same "sync takes a long
  // time" problem that concurrency already fixed for push/pull's own
  // per-object work.
  //
  // Correctness under concurrency: each step below never lets one item's
  // failure throw out of mapWithConcurrency (which would abandon the
  // other in-flight items with no way to know which succeeded) — it
  // catches per-item and returns a per-item outcome instead, so the
  // caller can always tell exactly which files actually got quarantined
  // regardless of completion order.
  const quarantineOutcomes = await mapWithConcurrency(loosePaths, TRANSFER_CONCURRENCY, async (relPath) => {
    const qPath = `${QUARANTINE_DIR}/${quarantineFilename(relPath)}`;
    try {
      await fs.rename(`${dir}/${relPath}`, `${dir}/${qPath}`);
      return { relPath, ok: true };
    } catch (err) {
      console.warn(`SmartChef: GC quarantine rename failed for ${relPath}:`, err);
      return { relPath, ok: false };
    }
  });
  const quarantined = quarantineOutcomes.filter((o) => o.ok).map((o) => o.relPath);

  // Independently prove the pack actually serves every one of these
  // objects BEFORE permanently deleting anything — but only bother
  // checking if every file actually made it into quarantine; a partial
  // quarantine already means restoring, no need to also read through the
  // pack first. This can only be a real test of the pack itself — not a
  // silent no-op that happens to "pass" via the loose file it's supposed
  // to be replacing — because those loose files were just moved out of
  // their expected location above: isomorphic-git checks loose storage
  // before packed storage on every read, so with the loose copy gone, a
  // successful read here can only have come from genuinely walking
  // objects/pack/*.idx.
  const fullyQuarantined = quarantined.length === loosePaths.length;
  const verified = fullyQuarantined && (
    await mapWithConcurrency(oids, TRANSFER_CONCURRENCY, async (oid) => {
      try {
        await git.readObject({ fs: { promises: fs }, dir, gitdir, oid });
        return true;
      } catch (err) {
        console.warn(`SmartChef: GC pack verification failed for oid ${oid}:`, err);
        return false;
      }
    })
  ).every(Boolean);

  if (!verified) {
    if (!fullyQuarantined) console.warn('SmartChef: GC quarantine was incomplete, restoring what was moved and skipping this pass');
    else console.warn('SmartChef: GC pack verification failed, restoring loose objects untouched');
    await mapWithConcurrency(quarantined, TRANSFER_CONCURRENCY, async (relPath) => {
      const qPath = `${QUARANTINE_DIR}/${quarantineFilename(relPath)}`;
      await fs.rename(`${dir}/${qPath}`, `${dir}/${relPath}`).catch((restoreErr) => {
        // A failed restore here is the one genuinely bad outcome this
        // function can produce — the object is neither at its loose path
        // nor provably reachable from the pack. Logged loudly; the file
        // itself still physically exists under QUARANTINE_DIR either way
        // (rename only fails atomically, it doesn't delete), so nothing
        // is actually lost, just misplaced until a future run's mkdir
        // scan... this doesn't self-heal today, hence the loud log.
        console.error(`SmartChef: could not restore quarantined object ${relPath} — it remains at ${qPath}:`, restoreErr);
      });
    });
    return { packed: 0 };
  }

  // Verified — the quarantined copies are now genuinely redundant with
  // the pack; delete them for real.
  await mapWithConcurrency(quarantined, TRANSFER_CONCURRENCY, async (relPath) => {
    const qPath = `${QUARANTINE_DIR}/${quarantineFilename(relPath)}`;
    await fs.unlink(`${dir}/${qPath}`).catch(() => {});
  });
  await fs.rmdir(`${dir}/${QUARANTINE_DIR}`).catch(() => {}); // best-effort tidy-up, matches rmdir()'s existing tolerant stance elsewhere

  return { packed: oids.length };
}
