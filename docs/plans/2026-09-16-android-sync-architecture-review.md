# Android sync architecture — a review of the git-based design

> **Scope**: how sync works today, what it actually costs on Android, whether
> "pull the repo, then read profiles → recipes → … directly on device" is
> better, and what else is available. Analysis only — nothing in this document
> is implemented yet.
>
> Everything measured below was measured against the real library
> (`MGriot/SmartChefSync-`: 400 entity files — 292 ingredients, 44 recipes,
> 26 tools, 21 tags, 12 techniques, 5 profiles), not estimated.

## 0. Read this part first — sync is currently broken

Found while mapping the system, unrelated to performance and more urgent than
anything else here.

**The desktop has not successfully pushed since 9 September.** Its Hidden Clone
is **82 commits ahead** of the remote:

```
local  refs/heads/main            329c8890a  2026-09-13 17:15  "sync: 270 changes from device-f8af7039"
remote refs/remotes/sync-folder/  098268c04  2026-09-09 20:15  "sync: 1 change from device-e2db6b58"
```

The tracking ref's own mtime is 2026-09-13 19:20, so **fetch works** — the
device correctly observed the remote. Only the push is failing.

Fetch on a public repository needs no credentials; push does. `authFor()`
returns `undefined` when no token is stored, so an unauthenticated push gets
401, `git.push()` throws, and `syncGitRemoteMode()` catches it into
`transportFailure`. Then:

```ts
async function reportTransportOutcome(ok: boolean, err?: unknown) {
  if (isElectron()) return;          // ← nothing is surfaced on desktop
  await setSyncPauseReason(...);
}
```

On Android a transport failure raises the sync-paused banner. **On Electron it
is swallowed entirely** — one `console.warn` and nothing else. So a week of
failed pushes produced no visible symptom anywhere.

Two consequences that matter right now:

1. Every device syncing from this remote is a week stale.
2. **The remote has no `images/` directory at all.** The local clone has one
   with 34 files; the remote's tree is `ingredients, profiles, recipes, tags,
   techniques, tools`. The 2026-09-13 "270 changes" commit — the inline-image
   migration and the images it produced — is one of the 82 that never left the
   desktop. A device setting up against this remote today gets 44 recipes whose
   covers point at `images/<hash>` files that do not exist there. That is
   precisely the dangling-reference failure ADR 0003's implementation note
   warned about.

**Fix first, before any of the rest of this document**: confirm the desktop has
a token with write access, and make a transport failure visible on Electron
rather than early-returning. The performance work below is pointless while the
data is not arriving.

## 1. How sync works today

Four moving parts, in the order a cycle touches them:

| | |
|---|---|
| **Local Storage** | The live SQLite database and image files. The app's actual datastore. |
| **Hidden Clone** | A private git working copy the app manages, one per device. Never seen by the user. |
| **Sync Folder / Git Remote** | Where devices meet. Either a folder replicated by Syncthing/Drive (**folder mode**), or a real git server (**git-remote mode**, ADR 0004). |
| **Structured Merge** | Field-level JSON merge against the common ancestor — *not* git's textual merge, so a conflict can never leave conflict markers inside an entity file (ADR 0001). |

A cycle (`syncNowInternal`) is:

1. `commitNowInternal()` — copy new images into the clone, `statusMatrix` over
   the committed dirs, and if anything changed, `add` + `commit`.
2. Fetch (git-remote: `git.fetch`; folder: hand-rolled object copying, because
   isomorphic-git's fetch/push are hard-locked to HTTP and cannot target a
   folder — see ADR 0001's 2026-08-20 update).
3. `applyMergeIfNeeded()` → `mergeRemoteIntoLocal()` — for every entity, read
   three versions (base, local, remote) out of git objects, merge field by
   field, write the result into SQLite.
4. Materialize any new images, write the merged entity files back, commit.
5. Push, with a bounded retry; then pack loose objects.

The design is sound and the reasoning in the ADRs holds up. What follows is not
an argument against it — it is about what it costs *on this particular
runtime*.

## 2. What it costs on Android

One structural fact drives everything: **isomorphic-git runs in the WebView and
reaches the filesystem through `gitfs.ts`, where every single call is a
Capacitor bridge crossing** — the whole file, base64-encoded in Java,
JSON-serialized, parsed in JS. Desktop pays a few microseconds per call;
Android pays milliseconds, plus payload cost.

So the unit that matters is not bytes or CPU. It is **number of filesystem
calls**.

### 2a. Reading 400 entities costs 2,402 filesystem calls — 2,400 of which find nothing

Measured, reading every entity the way `mergeBridge.ts` does — `git.readBlob({
oid, filepath })` — with one shared cache:

```
400 readBlob(commitOid, filepath), one shared cache:
   1600 x  .git/objects/<xx>/<oid>   (loose)
    800 x  (internal lookups)
      1 x  .git/objects/pack/…​.idx
      1 x  .git/objects/pack/…​.pack
  TOTAL 2402 calls, of which 2400 MISSED — the file does not exist
```

Two calls read real data. The other 2,400 are **failed lookups**.

The cause: isomorphic-git checks loose object storage before packed storage on
every read, and after a clone or fetch *everything is packed*, so every loose
check misses. Resolving one entity by path walks commit → tree → subtree → blob,
and each of those four objects is looked up loose-first.

On Android each miss is a full bridge round trip that throws. At 5–15 ms per
crossing, that is **12–36 seconds of pure "file not found"** to read a library
that is 1.4 MB of JSON.

The object cache added in 1.1.5/1.1.6 does not help here and was never going to:
it stops the *pack* being re-read (visible above — the pack is read exactly
once), but it cannot stop a miss that never reaches the pack.

### 2b. Every cycle spends ~846 calls discovering nothing changed

`commitNowInternal()` runs `statusMatrix` over the committed directories before
it can tell whether there is anything to commit:

```
400 files tracked, 0 changed
167 ms | 846 fs calls (11 missed) | 12.4 MB read
```

At 5–15 ms per crossing: **4–13 seconds, on launch, on every resume, and every
five minutes** — whether or not the user has touched anything.

### 2c. Summary of the first-sync budget

| Stage | fs calls | Notes |
|---|---|---|
| Shallow clone (probe, 1.1.8) | ~93 | already cheap; superseded by the host API path |
| Fetch + index pack | ~50 | |
| **Merge reads** | **~2,400** | almost entirely misses |
| Write entity files back | ~400 | writes |
| `statusMatrix` + add + commit | ~850 | |
| Pack + verify loop | ~200+ | fixed in 1.1.6 (was ~40,000) |

Roughly **4,000 bridge crossings** for a first sync, of which more than half
find nothing.

## 3. The proposal: pull, then read profiles → recipes → … on device

**Verdict: the instinct is right, and the numbers back it — for bulk
hydration. Keep the current path for incremental syncs.**

Measured, the same 400 entities both ways:

```
from git objects   1723 ms | 2402 fs reads | 12.4 MB
checkout the tree   289 ms |   26 fs reads (+400 writes)
then plain files    497 ms |  400 fs reads |  3.1 MB
```

`checkout + plain reads` is **~826 crossings against ~2,402** — about three
times fewer — and four times fewer bytes. And the 400 writes are **not extra**:
a first sync already writes every touched entity's file back into the working
tree, so the checkout largely replaces work that happens anyway.

Three things make this safe and worth doing, and one constraint that must be
respected:

- **A first sync is not a merge.** With no local history, `readEntityJson()`
  returns `null` for base and local without any I/O, and every entity takes the
  `createEntity()` path. It is a pure import wearing a merge's clothes. Reading
  the checked-out tree directly is exactly equivalent, and much cheaper.
- **Priority ordering is free.** `ENTITY_DIRS` already iterates types in a fixed
  order (ingredients, tools, tags, techniques, profiles, recipes). Putting
  profiles first and recipes early costs nothing and makes the app usable
  sooner.
- **Progress becomes honest.** Per-type completion is a natural place to report
  "profiles ready… 44 recipes imported…", which the gallery banner can already
  consume via `syncStatus.ts`.
- **The constraint: do not commit between types.** `applyMergeIfNeeded()`
  commits after a merge; if only some entity types had been applied,
  `findMergeBase()` would resolve to the remote oid on the next cycle, every
  skipped type would look unchanged, and it would never be imported again — a
  silently empty library. Order the work however you like; keep the commit at
  the end. This is written up in `firstRunProbe.ts`'s header for the same
  reason.

For **incremental** syncs the calculus reverses: only a handful of entities
changed, a checkout would rewrite the whole tree, and the three-way merge
genuinely needs base and local versions the working tree does not hold. Leave
that path as it is.

## 4. Other options, ranked by value against effort

**1. Batch the bridge (biggest structural win).** The real problem is not git —
it is 4,000 individual crossings. A native `readMany(paths[])` / `statMany()` on
the plugin side would collapse the merge's reads and `statusMatrix`'s stats into
a handful of calls. This helps *every* path at once, including the ones not
touched by anything above, and does not require changing the sync design at all.

**2. Skip `statusMatrix` when nothing local changed.** The app knows when it
writes an entity file (`writeEntityFile`, `scheduleCommit`). A persisted
"pending local changes" flag would let `commitNowInternal()` return immediately
on the common no-op cycle — removing ~846 calls from launch, every resume, and
every five minutes. Small change, large and continuous payoff.

**3. Checkout-and-import for bulk hydration** — section 3. ~3× on the
first-sync merge.

**4. Hydrate a new device from a snapshot instead of a history.** The app
already has `exportSnapshot`/`importSnapshot` (`backup.local.ts`): one JSON
document containing everything. Committing a snapshot alongside the entity files
— the same shape as the existing `sync.bundle` catch-up — would let a new device
fetch one file and bulk-insert it, skipping the pack, the merge and the
per-entity work entirely. Costs duplication in the repo and freshness logic; the
biggest possible win for first-run, and the most new machinery.

**5. Move git off the WebView.** A Web Worker would not help — the bridge is the
cost, not the JS. A native Java sync implementation would, and is a rewrite.
Noted for completeness; not recommended.

**Not recommended: replacing git.** The ADRs make a genuinely good case, and
nothing found here undermines it. Structured Merge with real conflict detection,
a format users can inspect with ordinary git, and two interchangeable
transports are worth keeping. The problems above are about how the runtime
reaches the filesystem, not about git being the wrong model.

## 5. Suggested order

1. **Fix the push** (section 0) and make transport failures visible on Electron.
   Everything else is moot while data is not arriving.
2. Skip `statusMatrix` on no-op cycles — cheapest large win, helps every cycle.
3. Batch reads/stats in the native plugin — the structural fix.
4. Checkout-and-import for bulk hydration, with profiles first and progress per
   type.
5. Revisit the snapshot idea only if first-run is still unsatisfying after 2–4.
