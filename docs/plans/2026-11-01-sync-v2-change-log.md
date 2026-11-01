# Sync v2: one change log per device, on any storage

*Design proposal, 2026-11-01. No code changed.*

**The question.** Should SmartChef's storage and sync be redesigned so that:
- it is faster;
- it breaks less often;
- the device stays the primary store;
- a cloud store (OneDrive, Google Drive, Dropbox, WebDAV, GitHub, GitLab, Gitea…) keeps devices *and users* in step;
- everyone can work offline, at their own pace?

**The answer.** Yes, and the change is in **what** is synced, not where.

Today every device keeps a git repository of the whole library and exchanges git objects. The proposal is that every device keeps an **append-only log of its own changes** and only reads other devices' new entries. That one change:
- makes a sync a handful of requests instead of thousands of file operations;
- removes every storage-level race;
- lets *any* storage that can save and list files act as the meeting point, git hosts included.

The current git design has **no counterpart in v2**. What it replaces is listed in §7.

---

## 1. Why the current design is slow and fragile

The September review (`docs/plans/2026-09-16-android-sync-architecture-review.md`) and the cloud study (`2026-11-01-cloud-storage-sync.md`) measured where the costs come from. **The costs come from the design, not from bugs:**

- **The whole library is mirrored as a git working tree.**
  - Each save writes a JSON file next to the SQLite write, fire-and-forget (`writeEntityFile`). Two copies of the truth can drift, and the code needs `sync_index`, `sync_repair` and `syncReconcile.local.ts` to keep them matched.
- **Git works one file at a time, and on Android every file call crosses the Capacitor bridge.**
  - A first sync is about **4,000 bridge crossings**, 2,400 of them failed lookups.
  - An idle cycle used to cost about 850 calls. `dirtyPaths` now skips most of that, but merge reads still walk commit → tree → blob for every entity.
- **The shared copy has one hot file every device fights over: the ref.**
  - Folder mode has no atomic write, so it relies on a read-back plus the manifest and bundle fallbacks.
  - Git-remote mode retries rejected pushes.
  - Cloud drives would add rate limits and eventually-consistent listings on top.
- **One cycle does a lot of steps:** pull, three-way merge, commit, push, retry. Each step is a place where a cycle can stop halfway, and about 40 of the last 220 commits touch sync.

None of this is about the merge rules (`structuredMerge.ts`, `mergeNormalize.ts`). Those are good and are kept.

## 2. The model

```
Device A                                Shared store (any backend)
┌────────────────────────┐              smartchef/
│ SQLite (the truth)     │                format.json            ← version + library id
│  ├ recipes, …          │                devices/
│  ├ change_log  ────────┼── push ──►       A/
│  ├ field_clock         │                    head.json          ← my last seq + what I've seen of others
│  └ sync_cursor ◄───────┼── pull ───       log/000001-000250.jsonl.gz   (immutable)
└────────────────────────┘                    log/000251-000263.jsonl.gz
                                           B/ …
                                         snapshots/<library-hlc>.json.gz  (immutable, any device may write)
                                         blobs/<sha256>.<ext>             (images, immutable)
```

1. **Every save writes its change into SQLite, in the same transaction.** A `change_log` row looks like:

   ```
   { seq, hlc, device, entity_type, entity_id, field, value }
   ```

   - There is no separate file copy, so nothing can drift.
   - A recipe edit that touches three fields produces three rows.
   - A delete is the field `deleted_at` set to a time.
2. **The clock is a Hybrid Logical Clock (HLC)**: wall time plus a counter plus the device id.
   - It never goes backwards, and it orders any two changes the same way on every device.
   - Each field's current HLC is stored in `field_clock(entity_type, entity_id, field, hlc, device)`.
3. **Push** uploads the unsent `change_log` rows as one gzip segment under the device's own folder, then rewrites its own `head.json`.
   - Only that device ever writes in its folder, so nothing needs locking.
4. **Pull** lists `devices/*/head.json` and compares each device's seq with the local `sync_cursor`. It then downloads only the missing segments and applies them **in one SQLite transaction**:
   - For each field: if the incoming HLC is newer than `field_clock`, write the value; otherwise ignore it.
   - Every device ends with the same result, whatever order changes arrive in. There is no merge base, no three-way merge and no retry loop.
5. **Snapshots** keep new devices fast.
   - Any device may occasionally write the full library as one file, recording the seq it covers per device.
   - A new device downloads the newest snapshot plus the segments written after it: two or three files, then one bulk insert. This is option 4 from the September review, built in.
6. **Images** stay content-addressed (`blobs/<sha256>`), uploaded once and downloaded on demand. See §2b.

## 2b. Where data lives on the device: SQLite plus a file store

**Today.**
- Everything except images is in SQLite (`smartchef_localSQLite.db`, 8.3 MB on the desktop library).
- Images are **files**, not a blob database: `images/<sha256>.<ext>`, full resolution (`lib/localImages.ts`, ADR 0003). That is 47 files and 3.8 MB on the desktop. The recipe and ingredient rows hold only the reference (`cover_image_url`, `image_urls`, steps' `image_url`).
- With git sync each image exists **up to three times per device**: Local Storage, the Hidden Clone, and the Sync Folder.

**Is SQLite the right choice? Yes, for everything except the images themselves.**
- It is the only embedded database that runs on Electron and Android through one plugin.
- It is transactional, which v2 needs: the data change and its log row are written together.
- It already holds the whole app.
- The real cost on Android is the bridge (every call is serialized), not SQLite. v2 cuts the number of calls per sync from thousands to a few.
- Nothing else is worth a migration. IndexedDB is not durable on Android WebViews; Realm and others would need a rewrite of every `*.local.ts`.

**Should images move into SQLite as BLOBs? No.** Photos are hundreds of KB to several MB each. In SQLite they would:
- bloat the database and its backups;
- slow every query that touches those pages;
- on Android, travel through the bridge as base64 JSON on every read.

SQLite's own guidance is that blobs over about 100 KB are better as files. Files can also be shown straight from disk by the WebView without passing through JS.

**What v2 improves for images:**
- **Two copies instead of three.** The Hidden Clone copy disappears; the device keeps `images/`, and the store keeps `blobs/`.
- **On-demand originals.** Another device downloads a recipe's photos the first time they are shown, not during sync. A "download all photos for offline" switch covers the opposite need.
- **A small preview per image** (≈ 400 px WebP), generated locally and synced next to the original. Lists and cards load the preview; full screen loads the original. This is the existing `backupImages.service.ts` recompression, reused for display only, so ADR 0003's "originals are never replaced" still holds.
- **With encryption on,** blobs are encrypted and named by a keyed hash (HMAC of the image hash with the library key). Otherwise the cloud provider could recognise a known photo by its plain SHA-256.

## 3. Merge rules: the current rules, applied per change

| Data | Today (`structuredMerge.ts`) | v2 |
|---|---|---|
| Scalar fields (title, times, difficulty…) | three-way, then newest-wins or ask | **newest HLC per field wins** |
| Sets (tags, regions, synonyms) | member by member | changes are `add x` / `remove x`, each with its own HLC (an add-wins set) |
| Translations | per language | one field per language: `translations.it` |
| Steps / ingredients / tools of a recipe | whole array (ADR 0002) | still a whole array as **one field**, so the same behaviour |
| Edit vs delete | `resolveModifyDelete` | `deleted_at` is a field; an edit newer than the delete brings the entity back, as today with *newest* |
| Name collisions (categories, units) | portable ids + `sync_alias` | unchanged: ids are already portable |

**The "ask me" conflict policy still works.** `head.json` records how far each device had read the others (a version vector). So when a change arrives, the app can tell:
- whether its author **had seen** the local value, which makes it a normal edit; or
- whether both sides changed the field **without seeing each other**, which makes it a real conflict.

Real conflicts go into `sync_conflicts` exactly as today. The newest value is shown until the user chooses, and choosing writes a new change. `ConflictResolver.tsx` is kept as it is.

## 4. Storage backends: one small interface

```ts
interface SyncStore {
  list(prefix: string): Promise<string[]>;
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, data: Uint8Array): Promise<void>;
}
```

That is all v2 needs. There is no compare-and-swap, because every file is either immutable or written by one device only. Eventually-consistent listings are harmless: a segment missed this cycle is picked up the next.

| Backend | How | Sign-in |
|---|---|---|
| **Local / synced folder** (Syncthing, desktop OneDrive/Dropbox/Drive clients) | Electron `fs`; Android SAF (`SafMirrorPlugin`, kept) | none |
| **WebDAV** (Nextcloud, ownCloud, Koofr, pCloud, NAS) | `PROPFIND` / `GET` / `PUT` | app password |
| **Dropbox / OneDrive / Google Drive** | provider REST in an app folder (`drive.file` on Google, so no security review) | OAuth 2 PKCE |
| **GitHub / GitLab / Gitea / Forgejo** | real git commits with isomorphic-git (decision: keep GitHub as sync storage) | token, as today |

**The git hosts stay first-class.** The git adapter commits the store's files to the repo and pushes, so every sync is a visible commit on GitHub, as today.
- Each device commits only its own folder. When a push is rejected because another device pushed first, the adapter fetches and re-commits on top. The two commits touch different files, so this never needs a merge. It is a fast-forward rebase, not today's three-way merge.
- isomorphic-git stays, but only inside this adapter. The rest of sync no longer depends on it.
- What is committed is the log, snapshots and blobs, not one JSON file per recipe. Readable recipe files on GitHub were not requested.

All requests go through `nativeHttpClient.ts`, so there are no CORS issues. OAuth, token storage and per-provider details are as laid out in the cloud study §5–§6. That work carries over unchanged; only the interface underneath is simpler.

**End-to-end encryption: on by default, can be turned off** (decision).
- Segments, snapshots, head files and blobs are encrypted with a random 256-bit **library key** (AES-GCM, the same Web Crypto code as `setupConfigFile.ts`). Google, Microsoft or GitHub store only ciphertext.
- The key reaches other devices in the Setup File, which is already protected by a passphrase. A device that loses the key can't read the store, so setup also offers a printable **recovery code**.
- Turning encryption off is a per-library choice made when the library is created (`format.json` records it). Switching later rewrites the store once.
- **Cost:** with encryption on, the files in the repo are not readable on github.com. The commit history (when, which device) still is.

## 5. Several users, offline, at their own pace

- **Your household is just more devices.** Everyone in the household joins the same library, as with today's profiles. Their devices write their own logs next to yours.
- **Separate libraries can share recipes** (decision: both kinds below).

  **a. "Send a copy": one-time, works between any two people.**
  - The app writes one share file: the recipe plus the things it needs (its ingredients, units, tools, techniques, sub-recipes, and photo previews or originals). It is encrypted with a key that is part of the share link or file.
  - Delivery: any channel (message, email, AirDrop) as a `.smartchef` file. Or upload it to the sender's own store and send a link that reads that one file, with no access to the rest.
  - The receiver previews it and imports it as **their own** recipe, with a new id and a "shared by …" source. Ingredients, units, tools and techniques are matched by name, using the existing portable ids, `sync_alias` and the import flow's matching. Later edits on either side stay separate.

  **b. "Shared collection": live, both ways.**
  - A collection is a **small library of its own**, with the same store layout (`format.json`, `devices/`, `snapshots/`, `blobs/`) and its own key, in a place every member can open: a shared Drive or OneDrive folder, a Dropbox shared folder, or a GitHub repo with collaborators.
  - Each library can join any number of collections. Joining needs an **invite**: the store location plus the collection key, in the same passphrase-protected format as the Setup File.
  - A recipe placed in a collection gets a `collection_id`. Its changes go into the collection's log instead of the private library's log, and every member's app pulls that log as well. The merge rules and conflicts are the same as for devices; a member is just more devices.
  - Ingredients, units, tools and techniques used by shared recipes are synced inside the collection too, and mapped by name onto each member's own catalog, so a shared recipe never forces a duplicate "Farina".
  - Leaving a collection keeps a private copy. Removing a member means rotating the collection key and re-inviting the others. That is the only way to revoke access without a server, and it only blocks *future* changes.
  - Access is all-or-nothing within a collection. Per-person read-only roles would need a server and are out of scope.
- **Offline and async come for free.** Changes queue in `change_log` with no limit on how long a device stays offline. When it comes back, its log is applied in HLC order, so an old phone that was in a drawer for a month cannot overwrite newer edits.
- **History becomes better, not worse.** The log has every field change with its time and device. A recipe can show "what changed, when and on which device" and restore any earlier value. Today that history exists in git but the app cannot show it per recipe.
- **Old history is compacted** (decision).
  - Each `head.json` records how far that device has read every other device. Once **every known device** has read past a segment, and the segment is older than a retention window (default 6 months), any device may fold it into a new snapshot.
  - The device that wrote a segment is the only one that deletes it. Deletion happens after it sees a snapshot covering it, so no file is ever deleted by two writers.
  - A device that hasn't synced in longer than the window catches up from the snapshot instead of the segments. Its own unsent changes still apply on top, by HLC, so nothing it wrote is lost.
  - Per-recipe history therefore reaches back to the retention window. Older versions survive as the snapshots themselves ("the recipe as of March").
  - On a git host, the deleted segments stay in the repo's commit history, so GitHub keeps the full record either way.

## 6. What it costs, and how fast it gets

| | Today (git) | v2 |
|---|---|---|
| Idle sync (nothing changed) | statusMatrix + fetch/list + ref compare | list `devices/` + read N tiny head files |
| Sync after 1 edit | write file, commit, list or fetch objects, merge, push | 1 segment PUT + 1 head PUT |
| First sync, 400 recipes, Android | ~4,000 bridge calls, minutes | download 1 snapshot + a few segments, 1 bulk insert: a few bridge calls |
| Files on the store | thousands of loose objects | a few files per device, plus images |
| Storage needs | git server, or a folder with a careful read-back | anything with list / get / put |

**Rough effort**, for one developer who knows the codebase, including tests in the style of `twoDevice.sync.integration.test.ts`:

| Phase | Scope | Estimate |
|---|---|---|
| 1. Core | `change_log`, `field_clock`, HLC; log every write from the `*.local.ts` services in the same transaction; apply-incoming with field rules; version vectors → `sync_conflicts` | 2–3 weeks |
| 2. Store + loop | `SyncStore` + folder adapter (Electron, SAF); push/pull/snapshot; sync status UI reused | 1 week |
| 3. Migration | Each device writes a snapshot of its current DB; the first v2 sync merges those snapshots with today's rules; old git sync stays read-only for one release, then removed | 1 week |
| 4. Git hosts + WebDAV | git adapter on isomorphic-git (GitHub/GitLab/Gitea, real commits), WebDAV adapter | 1 week |
| 5. Encryption + images | library key, recovery code, encrypted blobs with keyed names; previews; on-demand originals | 1–1.5 weeks |
| 6. Compaction + history | read-progress in `head.json`, snapshot folding, segment cleanup; per-recipe history view | 1 week |
| 7. OAuth + Dropbox / OneDrive / Drive | as in the cloud study, phases 2–5 | 2–3 weeks |
| 8. Sharing | "Send a copy" (share file and link, import with name matching): ~1 week. Shared collections (second store per library, invites, `collection_id`, catalog mapping, leave and key rotation): 2–3 weeks | 3–4 weeks |
| | **Total** | **≈ 12–15 weeks** |

**Delivery order:**
- Phases 1–4 (≈ 5–6 weeks) already replace today's sync and deliver the speed and reliability, with folders, WebDAV and GitHub/GitLab/Gitea.
- Phases 5–6 make it private and keep it small.
- Phases 7–8 add the cloud providers and sharing. Either can ship first.

**Compared with the cloud study's plan** (cloud adapters on top of git, about 4–5 weeks): that plan adds clouds but keeps every cost in §1. v2's phases 1–4 and 7, the like-for-like part, cost about twice as much and remove those costs. Encryption, compaction and sharing are new features on top.

## 7. What it replaces and what it keeps

**Removed** (about 3,500 lines of `lib/sync/`):
- `gitSync.ts`, `mergeBridge.ts`, `hiddenClone.ts`, `gitObjectTransport.ts`, `gitBundleTransport.ts`, `gitPacking.ts`, `gitCache.ts`, `gitfs.ts`;
- the entity-file writers;
- `syncReconcile.local.ts` and `sync_repair`, because the file copy they reconcile no longer exists;
- isomorphic-git everywhere except the git-host adapter, where it stays.

**Kept:**
- SQLite and every screen;
- `structuredMerge.ts`'s normalisation (`mergeNormalize.ts` decides whether a change is a real edit);
- `conflicts.local.ts`'s storage and `ConflictResolver.tsx`;
- portable ids and `sync_alias`;
- content-addressed images;
- the Setup File;
- `nativeHttpClient.ts` and `GitHttpPlugin.java`.

**Decisions this supersedes** (to be recorded as a new ADR if accepted):
- ADR 0001 (bare-remote sync folder);
- ADR 0004 (git-remote mode);
- ADR 0006 (git-parented merges).

Its "never silently lose an edit" goal is kept, through version-vector conflict detection.

## 8. Alternatives considered

- **Keep git and add cloud adapters** (the cloud study). Cheapest way to reach the clouds, but speed and fragility stay. A good choice only if speed is acceptable after the September review's remaining items (batched bridge reads, checkout-and-import).
- **A ready-made sync library.**
  - Automerge and Yjs are document CRDTs: heavy per document and awkward on top of SQLite.
  - cr-sqlite is a native SQLite extension that `@capacitor-community/sqlite` can't load.
  - PowerSync and ElectricSQL need a server.
  - The log above is small, fits the existing tables, and reuses the existing merge rules.
- **A SmartChef server** (the old backend's role). Simplest consistency, but it gives up "no server needed", which is the point of standalone mode.

## 9. Decisions (2026-11-01)

1. **Sharing:** between separate libraries, both as a one-time copy and as live shared collections (§5).
2. **End-to-end encryption:** optional, on by default (§4).
3. **History:** old segments are compacted into snapshots once every device has read them and they are past the retention window (§5).
4. **GitHub:** kept as sync storage with real commits; isomorphic-git stays inside the git adapter only (§4). Readable recipe files in the repo were not requested.
5. **Local storage:** SQLite for data, content-addressed files for images, no blob database (§2b).

**Still open**
- The retention window (6 months proposed).
- Whether a shared collection's photos are full resolution or previews only. Full resolution costs every member's storage quota.
