// ════════════════════════════════════════════════════════════════════════
// SmartChef — One shared isomorphic-git object cache per sync cycle
//
// isomorphic-git takes an optional `cache` object on almost every call, and
// creates a fresh empty one when you don't pass it. That default is a trap
// once objects live in a packfile rather than loose on disk — which is
// exactly the state a device is in right after a clone or a fetch, i.e.
// precisely when the most reading happens.
//
// Resolving ONE object out of a pack means reading the pack, building its
// index and inflating from it. With a per-call cache, all of that is thrown
// away and redone for the very next object. Measured against the real sync
// repository (400 entity files, 12 MB pack), reading 60 blobs:
//
//     no cache      3026 ms   120 pack reads   744 MB off disk
//     shared cache   343 ms     2 pack reads    12 MB off disk
//
// mergeBridge.ts reads three blobs per entity (base, local, remote), so a
// full first sync of this library is ~1,200 reads. Projected from the same
// measurement that is about 61 seconds and 14.5 GB of file reads on a
// desktop NVMe — and on Android every one of those is gitfs.ts reading the
// whole file, base64-encoding it in Java and JSON-serializing it across the
// Capacitor bridge. That is not "slow", it is a sync that effectively never
// finishes, and it is why the first-run profile check still felt long even
// after it stopped downloading the whole history.
//
// ── Why module-level, and why it is reset ──────────────────────────────
// Threading a cache parameter through every function between syncNow() and
// readEntityJson() would touch a lot of signatures for one cross-cutting
// concern. The cost of a module-level one is that it must be dropped
// deliberately, for two reasons:
//
//   - Memory. It holds the pack it has read (~13 MB for a full first sync);
//     keeping that alive for the life of the app is not free on a phone.
//   - Staleness. gitPacking.ts rewrites .git/objects/pack and prunes the
//     loose objects it packed, so an index cached from before that runs
//     describes files that no longer exist.
//
// Hence resetGitCache() at the start and end of each cycle, and around
// packing. A cycle re-reads the pack once; the thing being avoided is
// re-reading it a thousand times within one.
// ════════════════════════════════════════════════════════════════════════

/** isomorphic-git treats this as an opaque bag — its shape is internal and
 *  deliberately not depended on here. */
let cache: object = {};

/** Pass as `cache:` to every isomorphic-git call inside a sync cycle. */
export function gitCache(): object {
  return cache;
}

/** Drops everything cached so far. Call when the object store may have
 *  changed underneath the cache (packing) or when a cycle ends and the
 *  memory should go back. */
export function resetGitCache(): void {
  cache = {};
}
