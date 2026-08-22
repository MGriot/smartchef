// ════════════════════════════════════════════════════════════════════════
// SmartChef — Bundle catch-up transport (fallback for gitObjectTransport.ts's
// MANIFEST_PATH completeness check)
//
// gitObjectTransport.ts's pullObjectsAndRefs() can now detect when a
// device's own directory listing of the Sync Folder came back short of the
// known-true object count (Google Drive's Android SAF provider being the
// documented offender — see that file's header). Detecting it turns silent
// wrong merges into a loud failure, but doesn't get the device un-stuck.
// This module is the fix for THAT: instead of enumerating (and re-checking
// the existence of) thousands of individual loose object files — the exact
// operation that transport was failing at — a device can pull ONE file
// containing everything and index it locally in one pass.
//
// Deliberately NOT a replacement for the day-to-day incremental transport:
// a full bundle re-uploads every object this device knows about, so
// writing one on every sync would throw away the "only transfer what's
// new" property that makes normal syncing cheap. writeBundleIfStale() only
// rewrites it when the local object set has grown meaningfully since the
// last one — this is purely a periodic safety net for the specific case
// where the incremental path is known to have failed.
//
// Real git-bundle-v2 format (a text header, a blank line, then a raw pack)
// — not a SmartChef-proprietary container — so the resulting file is
// genuinely openable via `git bundle verify`/`git clone` outside the app
// too, same idea a user would reach for by hand via `git bundle create`.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import type { RemoteTransport, LocalFs, GitPlumbingFs } from './gitObjectTransport';
import { listLocalObjectPaths, oidFromObjectPath, sha1Hex } from './gitObjectTransport';

const BUNDLE_PATH = '.git/sync.bundle';
const BUNDLE_META_PATH = '.git/sync.bundle.meta.json';
const BUNDLE_REF_NAME = 'refs/heads/main';
const BUNDLE_HEADER_SIGNATURE = '# v2 git bundle';

// Rewrite gate: skip re-uploading the whole snapshot unless the local
// object set has grown by at least this proportion AND this many objects
// since the last bundle — both thresholds, not either, so a device with a
// huge history doesn't get re-bundled over one new recipe, and a device
// with a tiny history doesn't wait forever for a 20%-sized delta to show up.
const REWRITE_GROWTH_RATIO = 1.2;
const REWRITE_MIN_NEW_OBJECTS = 100;

async function existsLocally(fs: LocalFs, dir: string, relativePath: string): Promise<boolean> {
  try {
    await fs.stat(`${dir}/${relativePath}`);
    return true;
  } catch {
    return false;
  }
}

interface BundleMeta {
  objectCount: number;
}

async function readRemoteBundleMeta(remote: RemoteTransport): Promise<BundleMeta | null> {
  try {
    if (!(await remote.exists(BUNDLE_META_PATH))) return null;
    const bytes = await remote.readFile(BUNDLE_META_PATH);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { objectCount?: unknown };
    return typeof parsed.objectCount === 'number' ? { objectCount: parsed.objectCount } : null;
  } catch {
    return null;
  }
}

/** Splits a bundle file's bytes into its parsed header fields and the raw
 *  pack bytes that follow — pure and synchronous so the format itself is
 *  unit-testable without a real git repository. Only understands the
 *  single-ref, no-prerequisites shape writeBundleIfStale() produces (a
 *  full snapshot bundle never has prerequisite lines); a bundle with
 *  those, e.g. one made by real `git bundle create X..Y`, would need more
 *  parsing than this — out of scope, since this module only ever reads
 *  bundles it wrote itself. */
export function parseBundle(bytes: Uint8Array): { refOid: string; refName: string; packBytes: Uint8Array } {
  const NEWLINE = 10;
  let headerEnd = -1;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === NEWLINE && bytes[i + 1] === NEWLINE) {
      headerEnd = i;
      break;
    }
  }
  if (headerEnd === -1) throw new Error('gitBundleTransport: malformed bundle (no header/pack separator)');

  const headerText = new TextDecoder().decode(bytes.subarray(0, headerEnd));
  if (!headerText.startsWith(BUNDLE_HEADER_SIGNATURE)) {
    throw new Error('gitBundleTransport: not a v2 git bundle');
  }
  const refLine = headerText.split('\n').slice(1).find((l) => l && !l.startsWith('-'));
  if (!refLine) throw new Error('gitBundleTransport: no ref line in bundle header');
  const [refOid, refName] = refLine.split(' ');

  return { refOid, refName, packBytes: bytes.subarray(headerEnd + 2) };
}

/** Writes a full git-bundle-v2 snapshot of every object this device's
 *  Hidden Clone currently has LOOSE — already an existing, accepted gap
 *  before gitPacking.ts existed (packed-only objects this device itself
 *  only ever received via a prior bundle catch-up, never as loose files,
 *  were never re-included here either; a device that has only ever
 *  caught up via bundles won't re-bundle beyond its own loose objects).
 *  gitPacking.ts's local packing after a successful push widens that same
 *  gap slightly further — objects it prunes also drop out of any bundle
 *  THIS device later writes — but doesn't change its shape: both are
 *  "this device's bundle only ever covers what it currently has loose,"
 *  not a new failure mode. Genuinely low-stakes: this bundle only matters
 *  as a fallback for another device's incomplete directory listing (see
 *  gitSync.ts's pullAndMergeOnce()), and gitPacking.ts only ever prunes
 *  what a push already confirmed is durably on the remote's own loose
 *  storage — which any normal, non-bundle pull reaches directly. No-ops
 *  when there's nothing committed yet, or when the existing remote bundle
 *  (if any) already covers a comparable object count — see
 *  REWRITE_GROWTH_RATIO above for why. Best-effort: every caller wraps
 *  this in a catch, since a failure here must never fail the sync cycle
 *  that triggered it. */
export async function writeBundleIfStale(fs: GitPlumbingFs, dir: string, gitdir: string, remote: RemoteTransport): Promise<void> {
  const localObjectPaths = await listLocalObjectPaths(fs, dir);
  if (localObjectPaths.length === 0) return;

  const existingMeta = await readRemoteBundleMeta(remote);
  if (
    existingMeta &&
    localObjectPaths.length < existingMeta.objectCount * REWRITE_GROWTH_RATIO &&
    localObjectPaths.length < existingMeta.objectCount + REWRITE_MIN_NEW_OBJECTS
  ) {
    return;
  }

  let refOid: string;
  try {
    refOid = await git.resolveRef({ fs: { promises: fs }, dir, gitdir, ref: 'HEAD' });
  } catch {
    return; // no commits yet
  }

  const oids = localObjectPaths.map(oidFromObjectPath);
  const { packfile } = await git.packObjects({ fs: { promises: fs }, dir, gitdir, oids, write: false });
  if (!packfile) return;

  const header = `${BUNDLE_HEADER_SIGNATURE}\n${refOid} ${BUNDLE_REF_NAME}\n\n`;
  const headerBytes = new TextEncoder().encode(header);
  const bundleBytes = new Uint8Array(headerBytes.length + packfile.length);
  bundleBytes.set(headerBytes, 0);
  bundleBytes.set(packfile, headerBytes.length);

  await remote.writeFile(BUNDLE_PATH, bundleBytes);
  await remote.writeFile(BUNDLE_META_PATH, new TextEncoder().encode(JSON.stringify({ objectCount: oids.length })));
}

/** Downloads and indexes the Sync Folder's bundle (if any) into this
 *  device's Hidden Clone in one file transfer, sidestepping whatever made
 *  this device's own directory listing of the Sync Folder come back
 *  incomplete in the first place. Returns false when there's no bundle to
 *  fall back on — the caller should treat that the same as the original
 *  incomplete-pull failure it was already handling.
 *
 *  Safe to call repeatedly: the imported pack is named by the SHA-1 of its
 *  own bytes, so re-applying an already-seen bundle is a cheap exists()
 *  check and nothing else — no bookkeeping of "have I done this before"
 *  needed, and a fresh device with no memory of prior syncs still gets
 *  the skip for free. Once indexed, this bundle's packed objects are
 *  never deleted — unlike gitPacking.ts's own local packs, which DO prune
 *  their loose originals once verified, a bundle-derived pack has no
 *  loose original to begin with, so there's nothing to reclaim either
 *  way. */
export async function tryCatchUpFromBundle(fs: GitPlumbingFs, dir: string, gitdir: string, remote: RemoteTransport): Promise<boolean> {
  if (!(await remote.exists(BUNDLE_PATH))) return false;

  const bundleBytes = await remote.readFile(BUNDLE_PATH);
  const { packBytes } = parseBundle(bundleBytes);

  const packHash = await sha1Hex(packBytes);
  const packFilepath = `.git/objects/pack/pack-bundle-${packHash}.pack`;

  if (!(await existsLocally(fs, dir, packFilepath))) {
    await fs.writeFile(`${dir}/${packFilepath}`, packBytes);
    await git.indexPack({ fs: { promises: fs }, dir, gitdir, filepath: packFilepath });
  }

  return true;
}
