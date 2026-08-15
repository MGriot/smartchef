# Android Folder-Sync Parity — Implementation Plan

Design: [2026-08-15-android-folder-sync-parity-design.md](./2026-08-15-android-folder-sync-parity-design.md)

Tasks are ordered so each one is buildable and testable on its own, without depending on a later task. Native plugin first (nothing else can be tested without it), then the fs-path change, then pull/push mirror logic in isolation (mockable, no device needed), then wiring into the existing sync loop, then the device registry, then UI, then the manual device pass last.

## 1. `SafMirror` native plugin scaffold

New Capacitor plugin under `frontend/android/`: Kotlin plugin class, package registration, Gradle wiring (parallel to how `capacitor-filesystem` was added — `capacitor.settings.gradle`, `capacitor.build.gradle`), and the TS-side ambient type declarations in a new `frontend/src/lib/safMirrorBridge.ts` mirroring `electronBridge.ts`'s `declare global` pattern. No behavior yet — just enough for `pickTree()` to return a hardcoded stub value and prove the JS↔native bridge is wired.
**Done when:** a stub `pickTree()` call from the renderer reaches the Kotlin plugin and returns a value, verified via a debug log or a temporary test button.

## 2. `pickTree()` / `hasPersistedTree()`

Implement the real SAF flow: `ACTION_OPEN_DOCUMENT_TREE` intent, `takePersistableUriPermission()` on the result, resolve a human-readable display name (SAF gives a URI, not a folder name — needs `DocumentFile.fromTreeUri().name`). `hasPersistedTree()` checks `contentResolver.persistedUriPermissions` for a previously granted tree.
**Done when:** picking a plain local folder through the Android emulator persists across an app restart (`hasPersistedTree()` returns it without re-prompting).

## 3. `list` / `readFile` / `writeFile` / `deleteFile`

Implement against `DocumentFile`: `writeFile` must create intermediate directories via `DocumentFile.createDirectory` since SAF has no bulk "write to nested path" primitive; `readFile`/`list` resolve by walking from the tree root by display name (no caching yet — that's the `AndroidMirrorState` optimization in task 6, not this task).
**Done when:** a round-trip write-then-read-then-list against a real picked folder returns correct bytes and filenames, exercised via instrumented test (task 4) rather than manually.

## 4. Instrumented Android tests for the plugin

Per the design's native testing section: real `DocumentFile` operations against a real local SAF tree (Android's picker can target a plain folder without a Drive/OneDrive account, so no cloud dependency here). Covers create/read/update/delete and the nested-directory-creation case from task 3.
**Done when:** these run in the existing Android test setup and pass against an emulator.

## 5. `gitfs.ts`: private-storage working copy + `/SmartChef` subfolder on both platforms

Two small, independent changes to `getSyncBasePath()`: Android now resolves to `Directory.Data` (private storage) instead of `Documents/SmartChef`; both Android's resolved path and Electron's user-chosen folder get `/SmartChef` appended, with `chooseElectronSyncFolder()` creating the subfolder if it doesn't exist yet.
**Done when:** existing Electron folder-sync (manually verified, since there's no existing automated coverage per the design doc) still works end to end against a freshly-created `SmartChef/` subfolder; Android's local git init now happens under private storage, unreachable by the user directly (expected — nothing else depends on that being externally visible).

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
