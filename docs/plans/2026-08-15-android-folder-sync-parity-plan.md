# Android Folder-Sync Parity — Implementation Plan

Design: [2026-08-15-android-folder-sync-parity-design.md](./2026-08-15-android-folder-sync-parity-design.md)

Tasks are ordered so each one is buildable and testable on its own, without depending on a later task. Native plugin first (nothing else can be tested without it), then the fs-path change, then pull/push mirror logic in isolation (mockable, no device needed), then wiring into the existing sync loop, then the device registry, then UI, then the manual device pass last.

## 1. `SafMirror` native plugin scaffold — DONE

Deviated from the original plan in two ways, both deliberate: written in **Java**, not Kotlin (the Android project has no Kotlin toolchain configured anywhere — `MainActivity.java` is plain Java — and adding one just for this would be its own scope creep); and registered directly in `MainActivity.java` via `registerPlugin(SafMirrorPlugin.class)` rather than as a separate Gradle module (`capacitor-filesystem`-style wiring is for consuming third-party/npm plugins — a bespoke, unpublished, app-specific plugin doesn't need that ceremony; this is Capacitor's own documented pattern for custom native code). `frontend/src/lib/safMirrorBridge.ts` uses `@capacitor/core`'s `registerPlugin()` (not a custom `contextBridge`-style global like `electronBridge.ts` uses for Electron — Android's Capacitor bridge already provides this mechanism natively). Verified via `:app:compileDebugJavaWithJavac` (JDK 21, since `capacitor-filesystem`'s own build requires it — the project's default JDK 17 can't build this module at all, pre-existing and unrelated to this plugin).

## 2. `pickTree()` / `hasPersistedTree()` — DONE

Implemented via `ACTION_OPEN_DOCUMENT_TREE` + `startActivityForResult`/`@ActivityCallback` (Capacitor's `Plugin` base class wraps AndroidX's Activity Result API). `takePersistableUriPermission()` on success; the chosen tree URI/display name are cached in the plugin's own `SharedPreferences` (separate from `AndroidMirrorState`, which is the JS-side cache from task 6+) so `hasPersistedTree()` can re-validate against `contentResolver.persistedUriPermissions` without the JS side needing to pass a URI back down. Capacitor's bridge can't resolve a bare JS `null`, so cancellation resolves `{ uri: null, displayName: null }` at the native layer; `safMirrorBridge.ts`'s exported `pickTree()`/`hasPersistedTree()` wrap the raw plugin calls and coerce that into `SafTreeHandle | null` for every other caller. Verified via compilation only — the interactive system picker itself isn't automatable (see task 4's notes); this is the piece manual QA (task 15) still needs to cover for real.

## 3. `list` / `readFile` / `writeFile` / `deleteFile` — DONE

Implemented against `DocumentFile`, walking from the tree root by display name for every call (no caching yet — that's `AndroidMirrorState` in task 6+). All writes use `application/octet-stream` uniformly (git objects and JSON files alike are opaque payloads we only ever read back ourselves by path, never rely on the OS to interpret by MIME type) and mode `"wt"` (truncate) so repeated writes to the same path overwrite rather than append. `writeFile` resolves+creates parent directories first, then creates-or-finds the leaf file. Compiles cleanly; correctness verified in task 4.

## 4. Instrumented Android tests for the plugin — DONE

Ran on a real booted emulator (not just compiled), 7 tests, all passing. One real finding along the way, written up in the design doc's Testing Strategy section: a file written via `ContentResolver.openOutputStream()` wasn't reliably visible to `File.listFiles()` on the same directory afterward — persistent, not transient. Traced to `DocumentFile.fromFile()` (the local-folder stand-in used here since the real SAF picker requires human interaction) allowing `ContentResolver`-write and raw-`File`-list to diverge — impossible against a real `tree://` URI, where both go through the same `DocumentsProvider`. Tests were adjusted to assert against the handles the code actually holds (`file.exists()`/`file.length()`/direct re-read) rather than forcing a re-list through an independently-resolved handle; a `list()`-specific test now uses a plain-`File`-written fixture instead. Also added a plain (non-instrumented) JUnit test, `SafMirrorPluginPathTest`, for the pure `parentPath()`/`fileName()` string logic — no Android runtime needed for those.

Real Drive/OneDrive document providers remain untestable in CI either way (task 15, manual QA).

## 5. `gitfs.ts`: private-storage working copy + `/SmartChef` subfolder on both platforms — DONE

`BASE_DIR` changed from `Directory.Documents` to `Directory.Data`; `ensureSyncFolderPermission()`'s Android branch dropped the `publicStorage` permission check entirely (`Directory.Data` needs no runtime grant, unlike `Documents`). `getSyncBasePath()` now appends `/SmartChef` to Electron's chosen folder (Android's `MOBILE_SYNC_DIR` constant already was `/SmartChef`, just relative to a different base now); `chooseElectronSyncFolder()` creates that subfolder immediately after picking rather than relying on the first sync tick's recursive `mkdir` to do it implicitly.

Also fixed, as a direct consequence rather than scope creep: several comments and two user-facing strings (Account.tsx's Folder Sync description, SyncHistory.tsx's header) asserted "Android writes to Documents/SmartChef" as architectural fact — now false. Updated those plus the affected comments in App.tsx, standalone.ts, electronBridge.ts, gitSync.ts. Account.tsx's Android copy is deliberately a placeholder ("private for now, Drive/OneDrive folder picking is coming soon") rather than describing a folder-picker UI that doesn't exist until task 12 — not overclaiming unbuilt functionality.

**Known transitional gap, expected and harmless given nothing is released yet:** Android folder-sync is now non-functional end-to-end until the SafMirror pull/push wiring (tasks 6-9) lands — the private working copy has no bridge to any other device until then. `Filesystem`, `Encoding` imports in gitfs.ts remain in use (mobile fs primitives unchanged, only `BASE_DIR`'s value changed).

Verified via `tsc --noEmit` and a full `vite build` — both clean.

## 6. `androidMirror.ts`: pull logic

New file. Given the plugin from task 3, implement the pull half of the design's mirror semantics table: list `.git/objects/` on the target, diff against `AndroidMirrorState.knownPushedObjects` (define this type now), fetch anything missing into the private working copy, then always-overwrite-pull `refs/heads/main`, `HEAD`, `recipes/*.json`, `ingredients/*.json`, and `devices/*.json`. Pure logic against an injected plugin interface — no real device needed.
**Done when:** unit tests (task 6a) pass against a mocked `SafMirrorPlugin`.

### 6a. Unit tests — pull logic

Mock `SafMirrorPlugin` with a fake in-memory tree. Verify: objects already known-pushed are never re-fetched; refs/JSON/devices files are always pulled if different; a device never treats another device's `devices/*.json` specially (just reads it).

## 7. `androidMirror.ts`: push logic

The push half: diff the private working copy's `objects/` against `knownPushedObjects`, upload only what's missing, then always-overwrite `refs/heads/main`, `HEAD`, changed `recipes/`/`ingredients/` JSON, and this device's own `devices/<id>.json`. Enforce objects-before-refs ordering explicitly (a sequencing assertion in the test, not just informal ordering in the code).
**Done when:** unit tests (task 7a) pass, including a simulated failure partway through that leaves the target in a state the pull logic from task 6 still interprets correctly (i.e. "nothing new yet," not corrupted).

### 7a. Unit tests — push logic + ordering

Assert call order is objects-before-refs. Assert a device only ever writes `devices/<its-own-id>.json`. Assert already-known-pushed objects are skipped.

## 8. Wire pull-before-init into `gitSync.ts`

Android-only branch in `syncNow()`/`initSyncRepo()`: call `androidMirror`'s pull step before the existing "no HEAD → `git.init`" check, per the design's correctness requirement. This is the task most likely to silently regress later, so its test (task 8a) should stay in the suite permanently, not be treated as a one-off validation.
**Done when:** task 8a passes.

### 8a. Unit test — pull-before-init ordering

Given a target with existing history and a private working copy with none, assert `git.init` never fires and the pulled history is adopted instead.

## 9. Wire push into `syncNow()`

Call the push step after the existing `commitNow()`, update `AndroidMirrorState` and the existing `LAST_SYNC_KEY` on success.
**Done when:** integration tests (task 10) exercise the full pull → reconcile → commit → push cycle end to end against the fake in-memory tree.

## 10. Integration tests — two-device convergence

Two `androidMirror` instances sharing one fake in-memory SAF tree (reusing the task 6/7 mocks). Scenarios: device A creates a recipe, device B syncs and sees it; both devices edit different recipes concurrently (no conflict); both edit the *same* recipe concurrently (LWW-by-`updated_at` applies, exercised through the mirror layer for the first time — the logic itself already exists in `reconcileEntity()`).
**Done when:** all three scenarios pass without a real device.

## 11. Device registry

Extend `gitSync.ts` with the `DeviceRecord` type and a `writeDeviceRecord()` call inside `syncNow()`, on both platforms. `deviceName` sourced from `@capacitor/device`'s model name by default.
**Done when:** after a sync cycle on each platform, `devices/<id>.json` exists on the target with a fresh `lastSyncAt`, verified via the integration tests from task 10 extended to check this file too.

## 12. Account.tsx: folder picker parity + device list + paused-sync state

Remove the `isElectron()` gate on "Change Folder," wire it to `pickTree()` on Android. Add the editable device-name field. Surface the "sync paused — folder access lost" state from task 13's error handling. Add a simple list of `devices/*.json` entries ("last synced 2h ago from Mom's Tablet").
**Done when:** manually verified in the running app on both platforms (this is UI, not unit-testable in the way tasks above are).

## 13. Permission-lost error handling

Catch SAF permission errors in the mirror pull/push calls, surface the paused state (consumed by task 12), confirm local writes continue uninterrupted when this fires.
**Done when:** a test that revokes the mocked plugin's access mid-cycle confirms `syncNow()` doesn't throw, local SQLite writes still succeed, and the paused state is set.

## 14. SyncHistory.tsx: show device registry alongside commit history

Small addition to the existing read-only history view from task 11's data.
**Done when:** manually verified.

## 15. Manual device QA (not automatable, required before calling this done)

Per the design's Manual QA section: one real Android device and one Electron install sharing one real Drive-mirrored `SmartChef/` folder. Verify two-way convergence, an offline edit that syncs once reconnected, the permission-revoked recovery flow via "Change Folder," and app-killed-mid-sync tolerance. Also resolve the design's open question here — confirm whether a non-Drive/OneDrive SAF provider (if available for testing) works, and note the result back in the design doc.

## Explicitly not in this plan

Hosted-DB sync mode, move/rename support in the plugin, iOS — all called out as out of scope in the design doc, unchanged here.
