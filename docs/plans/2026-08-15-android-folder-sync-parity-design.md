# Android Folder-Sync Parity (incl. Google Drive / OneDrive folders)

Status: designed, not yet implemented
Related follow-up (separate design, not started): hosted-DB standalone sync mode

## Summary

This design gives Android's standalone-mode folder sync full parity with Electron's — including the ability to target a Google Drive or OneDrive folder, not just plain local storage — without touching the git logic that already works in `frontend/src/lib/sync/gitSync.ts`.

Today, Android's standalone mode runs isomorphic-git directly against a fixed path (`Directory.Documents/SmartChef`) via `@capacitor/filesystem`, because Android's Storage Access Framework (SAF) doesn't let an app freely pick an arbitrary folder path the way desktop can. Electron, by contrast, lets the user pick any real folder via a native dialog and runs git straight against it.

This design closes that gap with a new native Android plugin (`SafMirror`) that does two things: launches SAF's `ACTION_OPEN_DOCUMENT_TREE` picker — which can target Drive's or OneDrive's own document-provider trees, not just local folders — and persists the resulting URI permission; and exposes batched list/read/write/delete primitives against that tree.

Critically, isomorphic-git itself never talks to SAF. Android's git working copy moves from `Documents/SmartChef` into the app's private storage, where it runs exactly as it does today — same performance, same code path, zero new risk to the part that already works. The plugin's only job is a batched mirror step: after each local commit, push changed files up to the picked SAF target; before each sync cycle, pull down anything new, then let the existing reconciliation logic in `gitSync.ts` handle it as usual.

Both platforms now scope themselves to a `SmartChef/` subfolder of whatever folder the user picks, rather than treating the picked folder's root as the sync root — this is a small, deliberate behavior change on Electron too (see "Changes to existing behavior" below), acceptable here because this whole feature is still unreleased.

Out of scope for this version: move/rename support in the plugin (a rename is just a delete + rewrite in the next mirror pass, since this is a mirror-by-copy model, not a live filesystem), iOS, and any provider that doesn't register as a SAF document provider (plain Dropbox support is not confirmed and is called out as an open question below). The hosted-DB sync mode (local-first with a server as the reconciliation target instead of a folder) is intentionally a separate, later design — this document covers folder-sync parity only.

## Architecture

```
Android device                              Electron device
───────────────                             ───────────────
SQLite (local.ts) ← recipes.local.ts etc.   SQLite (local.ts) ← recipes.local.ts etc.
        │ commit                                    │ commit
        ▼                                            ▼
 isomorphic-git                              isomorphic-git
        │ (unchanged, fast path)                    │ (unchanged, fast path)
        ▼                                            ▼
 private-storage working copy                user-chosen folder/SmartChef (direct
 (Capacitor Filesystem, Directory.Data)        disk, via Electron IPC to Node fs)
        │
        │ mirror step (new, batched)
        ▼
 SafMirror native plugin
        │
        ▼
 <picked tree>/SmartChef  (Drive folder / OneDrive folder / plain local folder)
        └──────────────── same shared external folder ────────────────┘
                (this is how two devices' commits reach each other)
```

Three new pieces, all Android-only:

1. **`SafMirror` native plugin** (Kotlin, new Capacitor plugin) — `pickTree()`, `list(path)`, `readFile(path)`, `writeFile(path, data)`, `deleteFile(path)`, all resolved against a persisted SAF tree URI.
2. **`frontend/src/lib/sync/androidMirror.ts`** (new) — after `gitSync.ts` commits locally, diffs the working tree against what's already known to be on the target and pushes changed files through the plugin; on each sync cycle, pulls anything new from the target into the local working copy before reconciliation runs, and hands off to `gitSync.ts`'s existing logic exactly as if those files had appeared locally.
3. **`gitfs.ts` change** — `getSyncBasePath()` on Android now returns the app's private-storage path instead of `Documents/SmartChef`; the git-facing fs backend itself is untouched (still `@capacitor/filesystem`, just pointed at `Directory.Data`).

`gitSync.ts`'s reconciliation logic, `matrioska.local.ts`, `recipes.local.ts`, and everything above the fs layer are unaffected — this only inserts a new layer *below* git on Android, mirroring the existing `isElectron()` branch pattern already in `gitfs.ts`.

### A note on how sync actually works today (read before implementing)

`gitSync.ts` does not use git's merge/fetch machinery between devices. Each device commits locally into what it treats as a shared folder, and relies entirely on the OS-level cloud client (OneDrive, Drive, Syncthing) to replicate the *entire* `.git` directory byte-for-byte — objects, refs, `HEAD` — alongside the `recipes/`/`ingredients/` JSON files. The actual data reconciliation happens separately, at the JSON-file level, via last-write-wins on each row's `updated_at` (see `reconcileEntity()`). Git here functions as a browsable commit log for `SyncHistory.tsx`, not a merge engine. The Android mirror must replicate the same set of files the OS client would — it is not sufficient to think of this as "push new git objects, update a ref."

## Data Model

**`SafMirror` plugin interface**, mirroring the shape `electronBridge.ts` already uses for Electron so `gitfs.ts`'s callers stay symmetric:

```ts
interface SafMirrorPlugin {
  pickTree(): Promise<{ uri: string; displayName: string } | null>;
  hasPersistedTree(): Promise<{ uri: string; displayName: string } | null>;
  list(opts: { uri: string; path: string }): Promise<{ entries: SafEntry[] }>;
  readFile(opts: { uri: string; path: string }): Promise<{ data: string }>; // base64
  writeFile(opts: { uri: string; path: string; data: string }): Promise<void>;
  deleteFile(opts: { uri: string; path: string }): Promise<void>;
}
interface SafEntry { name: string; isDirectory: boolean; size: number }
```

**Mirror semantics** — what gets synced and how, per path in the `SmartChef/` subfolder:

| Path | Overwrite rule |
|---|---|
| `.git/objects/**` | Content-addressed & immutable — skip if the target already has a file of that name |
| `.git/refs/heads/main`, `.git/HEAD` | Always overwrite if different (tiny files, change every commit) |
| `recipes/*.json`, `ingredients/*.json` | Overwrite only if the remote copy's `updated_at` is newer than the local copy's — see note below |
| `devices/<deviceId>.json` (new) | Always overwrite, but only your own file — never another device's |

**Correction found during implementation (task 10):** "always overwrite if different" for `recipes/*.json`/`ingredients/*.json` was under-specified when first written — it was implemented in tasks 6/6a as unconditional overwrite, reasoning that `reconcileEntity()`'s own `updated_at` check downstream in `gitSync.ts` would protect SQLite regardless. That protects SQLite for the device doing the pulling, but not the *file* — if this device has a local edit that's newer than the target but hasn't been pushed yet, an unconditional pull overwrite destroys that edit at the file level before `reconcileEntity()` ever sees it, permanently losing it from the shared history (and from this device's own SQLite too, since reconcile only ever sees the post-overwrite, older content). A two-device integration test (task 10) surfaced this converging on the wrong answer; fixed by having the pull step itself compare `updated_at` before overwriting — the same comparison `reconcileEntity()` already does, just one layer earlier, where it can still make a difference. `devices/<id>.json` doesn't need this: each device only ever writes its own file, so there's no local edit to protect against.

**New shared device registry**, a `gitSync.ts` change affecting both platforms:

```ts
interface DeviceRecord {
  deviceId: string;      // existing DEVICE_ID_KEY value, unchanged
  deviceName: string;    // new — human-friendly, editable in Account.tsx
  platform: 'android' | 'electron';
  lastSyncAt: string;    // ISO, rewritten by that device on every syncNow()
}
```

Each device writes only `devices/<its-own-deviceId>.json` on every `syncNow()` — no merge logic needed, since files are disjoint by writer. `SyncHistory.tsx`/`Account.tsx` list all files under `devices/` to show e.g. "last synced 2h ago from Mom's Tablet." `deviceName` defaults from `@capacitor/device`'s reported model name and is editable via a new Account.tsx field, falling back to the existing anonymous `device-xxxxxxxx` id if never set.

**`AndroidMirrorState`** (local `Preferences` cache, Android-only, purely an internal perf optimization):

```ts
interface AndroidMirrorState {
  treeUri: string;
  treeDisplayName: string;          // shown in Account.tsx instead of a raw path
  knownPushedObjects: string[];     // object filenames already confirmed on the target
  lastSeenRemoteRef: string | null; // refs/heads/main value as of last pull
}
```

## Control Flow

**Happy path, Android `syncNow()`:**

1. **Pull first, always before init.** The mirror step reads `refs/heads/main` on the SAF target; if present, it pulls any objects the private working copy doesn't already have (a cheap content-addressed existence check), plus the current `recipes/*.json`, `ingredients/*.json`, and `devices/*.json`. This must happen before `initSyncRepo()`'s existing "no HEAD → `git.init`" check, so a new device joining an already-populated shared folder inherits the real history instead of creating a disconnected empty one. `git.init` should fire only when the target itself has no `refs/heads/main` yet.
2. `initSyncRepo()` / `reconcileEntity()` run exactly as today, now reading from private storage instead of the SAF tree directly.
3. `commitNow()` runs exactly as today, committing locally to the private working copy.
4. **Push.** The mirror step uploads any missing `objects/` entries, then overwrites `refs/heads/main`, `HEAD`, changed `recipes/`/`ingredients/` JSON, and this device's own `devices/<id>.json` with a fresh `lastSyncAt`. Push order matters: objects before refs/JSON, so a partial failure never leaves the target in an inconsistent state (see Error Handling).
5. `AndroidMirrorState` and the existing `LAST_SYNC_KEY` update.

Electron's `syncNow()` is unchanged in shape — no pull/push split, git still points straight at the chosen folder — aside from the new `/SmartChef` subfolder default.

**Error path — SAF permission lost** (URI revoked, provider app reinstalled, app storage cleared): plugin calls fail with a permission error. The mirror step catches this, sets a "sync paused — folder access lost" state surfaced in `Account.tsx` (parallel to Electron's existing "no folder chosen yet" error), and skips push/pull for that cycle. Local writes are unaffected — SQLite and local commits keep working normally. The existing "Change Folder" button (currently Electron-only, now shown on Android too) re-invokes `pickTree()` to recover.

**Error path — partial/corrupt file mid-cloud-upload:** same tolerance already present in `reconcileEntity()` — skip, retry next tick, never surfaced as a hard error.

## Error Handling & Edge Cases

**Folder picker cancelled during onboarding.** Same tolerance as Electron today — `initStandaloneProfile()` doesn't block on it; the profile and local SQLite are created regardless, and sync stays paused until a folder is chosen from Account.tsx.

**Push ordering must be objects-first, refs/JSON-last.** If the app is backgrounded or killed mid-push, the partial upload must leave the target in a safe prior state, never a half-written one. Because `objects/` entries are immutable and additive, uploading them first and only overwriting `refs/heads/main`/`HEAD`/the JSON files last means a partial failure looks like "nothing new arrived yet" to other devices — the next cycle retries cleanly. This is a correctness requirement, not an implementation detail.

**Concurrent ref writes from two devices syncing at nearly the same moment.** Not atomic — a second device's push can overwrite the first's `refs/heads/main` write with a ref based on stale history, orphaning the first commit's object (harmless — never deleted, just unreferenced) and dropping it from what `SyncHistory.tsx` displays. This is inherited from the existing design, not introduced here; Electron has the identical race today. No data is lost: the `recipes/`/`ingredients/` JSON files are reconciled independently by per-row `updated_at`, regardless of what the ref says, so only the git-log view is cosmetically incomplete.

**Open question:** whether non-Drive/OneDrive SAF-registered providers (e.g. Dropbox's Android app, if it exposes a `DocumentsProvider`) work out of the box is unconfirmed — should be verified during implementation rather than assumed either way.

## Testing Strategy

**Unit — `androidMirror.ts` diff/push/pull logic.** Mock `SafMirrorPlugin` with a fake in-memory tree. Verify objects already present are never re-uploaded; `refs/heads/main`, `HEAD`, changed JSON, and `devices/<id>.json` are always overwritten; push order is objects-before-refs; a device never writes another device's `devices/*.json`.

**Unit — pull-before-init ordering.** Given a target with existing history and a private working copy with none, assert `initSyncRepo()`'s `git.init` branch never fires — the pulled history is adopted instead. Worth its own explicit test given how easy this ordering bug would be to reintroduce.

**Integration — two-device convergence, no real device needed.** Two `androidMirror` instances sharing one fake in-memory SAF tree: device A writes a recipe and syncs, device B syncs and asserts the row lands correctly in its own SQLite. Repeat with concurrent edits to different recipes (no conflict expected), then concurrent edits to the same recipe (LWW-by-`updated_at` should apply, exercised through the mirror layer).

**Native — instrumented Android tests.** `SafMirror`'s actual `DocumentFile` calls, tested against a real local SAF tree (Android's document picker can target plain local folders without a Drive/OneDrive account) — covers the real native code path. Testing against an actual Drive- or OneDrive-backed document provider isn't realistically mockable in CI and requires manual device QA.

**Manual QA (required):** one real Android device and one Electron install sharing one real Drive-mirrored `SmartChef/` folder — verify two-way convergence, an offline edit that syncs once reconnected, the permission-revoked recovery flow via "Change Folder," and app-killed-mid-sync tolerance.

**Finding from implementation (SafMirrorPluginTest, run on a real emulator):** a file written via `ContentResolver.openOutputStream()` wasn't reliably visible to a subsequent `File.listFiles()` call on the same directory — persistent, not a transient race (didn't resolve even after ~1s of polling). This turned out to be specific to `DocumentFile.fromFile()` as a test stand-in for a real SAF tree: it lets `ContentResolver`-mediated writes and raw-`File`-mediated listing diverge, a split that's structurally impossible against a real `tree://` URI, where listing, reading, and writing all go through the same `DocumentsProvider`/`ContentResolver` path with no parallel `File` view to disagree with. It's flagged here anyway because it independently validates a design decision already made above: `androidMirror.ts` must not treat a `list()` call as authoritative confirmation of what it just pushed — `AndroidMirrorState.knownPushedObjects` is updated optimistically from each successful `writeFile()` result, never by re-listing afterward, which sidesteps this class of gap regardless of its root cause.

## Changes to existing behavior

- `gitfs.ts`: Android's `getSyncBasePath()` now resolves to private storage, not `Documents/SmartChef`.
- `gitfs.ts` / `gitSync.ts`: both platforms now scope to a `SmartChef/` subfolder of the picked/configured folder, rather than its root. Electron's `chooseElectronSyncFolder()` should create this subfolder if missing.
- `Account.tsx`: the "Change Folder" button, currently gated to `isElectron()` only, is now shown on Android too.
- `gitSync.ts`: adds the `devices/` registry, written by both platforms on every `syncNow()`.

## Explicitly out of scope for this version

- Hosted-DB standalone sync mode (separate, later design).
- Move/rename support in the `SafMirror` plugin.
- iOS.
- Any correctness guarantee for SAF-registered providers other than Google Drive and OneDrive (untested, not assumed to fail either).
