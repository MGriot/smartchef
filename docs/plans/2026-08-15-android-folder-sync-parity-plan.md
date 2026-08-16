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

## 6. `androidMirror.ts`: pull logic — DONE

Implemented as designed, with one refinement worth recording: rather than trusting `AndroidMirrorState.knownPushedObjects` as the skip-fetch source of truth for pull (which the design doc's task wording implied), pull decides what to fetch by checking **local existence directly** via `gitfs.promises.stat` — cheap, and always correct even if the cache is stale (app reinstalled, storage cleared) or was never populated (e.g. objects that arrived via a route other than this device's own prior pushes). The cache is still updated after a successful pull (renamed in a doc comment from "push-only" to "known synced both ways" — the field itself is unchanged, `knownPushedObjects`, to avoid a churn-only rename), so a subsequent push doesn't redundantly re-upload something just pulled. `pullFromTarget()` takes the plugin as a parameter (defaulting to the real `SafMirror` singleton) specifically so tests can inject a fake — no test-only exports or internal restructuring needed.

Also exported `base64ToBytes`/`bytesToBase64` from `gitfs.ts` (were private helpers) rather than duplicating them — `androidMirror.ts` needs the identical conversion for `SafMirrorPlugin` calls, which also speak base64.

### 6a. Unit tests — pull logic — DONE

No test framework existed in the frontend yet — added Vitest (`npm test` / `vitest run`), the natural fit for a Vite project, plus a minimal `vitest.config.ts`. Built a shared in-memory fake SAF tree (`src/lib/sync/testUtils/fakes.ts`, backed by a flat `Map`, directories derived from key prefixes) for reuse across this task, task 7a, and the task 10 integration tests, per the plan's original intent to build this once. `@capacitor/preferences` and `../gitfs` are both mocked at the module level (`vi.mock`) with in-memory equivalents rather than threading fs/prefs as constructor parameters — keeps `androidMirror.ts`'s public API clean of test-only injection points. 7 tests, all passing: no-tree/empty-target no-ops, object fetch + skip-if-local, refs/HEAD/JSON write-through, JSON overwrite-on-change, multi-device registry pull with no per-device special-casing, and the knownPushedObjects update after a successful pull.

## 7. `androidMirror.ts`: push logic — DONE

Implemented as designed. One asymmetry from pull worth recording: pull's skip-decision checks local existence directly (task 6's refinement, since "do I have this" is cheap to check locally and always correct); push's skip-decision has no equivalent cheap local check for "does the *target* have this" — a real check would mean a round trip, the exact cost the cache exists to avoid — so push genuinely does rely on `knownPushedObjects` as its source of truth, matching the original design. `getDeviceId()` is imported directly from `./gitSync` (confirmed safe: despite pulling in `isomorphic-git`, `@capacitor-community/sqlite` via `db/local.ts`, and `@capacitor/preferences` transitively, none of those execute anything at module-load time that fails under Vitest's Node environment — verified by running the existing pull tests unchanged after adding the import, before writing any push-specific code).

### 7a. Unit tests — push logic + ordering — DONE

7 tests: no-op with no tree configured, call-order assertion (objects before refs/HEAD, via a `writeFile` spy inspecting call sequence — not just checking end state), skip-if-known-pushed, own-device-only registry write, and two tests around a simulated mid-loop failure — confirms `refs/heads/main` is never written when an object upload throws (so a later pull sees "nothing new," not a dangling ref), and confirms whichever object succeeded *before* the failure is still remembered (so a retry doesn't redo it).

Hit one real test-isolation bug along the way, worth recording since it'll bite again if not understood: `androidMirror.ts` keeps `knownPushedObjects` in a **module-level variable**, not just in the mocked `Preferences` store — clearing the fake store between tests wasn't enough, since the module-level cache survived across tests within the same file and caused a later test to wrongly treat an object as already pushed. Pull's tests never hit this because pull's skip-decision doesn't consult that cache (see above). Fixed by `vi.resetModules()` + re-importing in `beforeEach`, matching what a real app restart would do — not a workaround like giving each test a unique tree URI, which would have hidden the same latent bug in any future test that reused a tree.

Extended `testUtils/fakes.ts` with a matching `createFakeLocalFs()` (same flat-Map-with-derived-directories shape as the SAF tree fake) and refactored the pull tests (6a) to use it instead of their original ad hoc mock, so both test files exercise the identical fake shape — the reuse across pull/push/integration (task 10) this was scoped for from the start.

## 8. Wire pull-before-init into `gitSync.ts` — DONE

`initSyncRepo()` now calls `pullFromTarget()` (Android only, `!isElectron()`) after the recipes/ingredients `mkdir`s but before the `resolveRef`/`git.init` decision, with a `.catch()` — a pull failure (no tree configured, target unreachable, permission lost) must never block local git init, since standalone mode has to keep working fully offline either way. This only runs once per app session (the existing `initDone` guard) — it's specifically about first-run correctness, not periodic sync. `syncNow()`'s own per-cycle pull/push (task 9) will call `pullFromTarget()` again on every tick regardless; the very first sync tick therefore pulls twice (once here, once there), which is harmless — the second call finds nothing new — and simpler than threading an "already pulled once" flag through two functions to avoid one redundant no-op call.

### 8a. Unit test — pull-before-init ordering — DONE

3 tests in `gitSync.pullBeforeInit.test.ts`: adopts an already-populated target instead of `git.init`-ing a disconnected history; still `git.init`s when the target genuinely has no history yet (a real first device); still `git.init`s when no SAF tree is configured at all (today's actual state for everyone, since task 12's onboarding UI doesn't exist yet).

Verified the test actually catches the regression it exists to guard against, not just correlated with the implementation: temporarily moved the `pullFromTarget()` call to *after* the `resolveRef`/`git.init` decision, re-ran the suite, confirmed the "adopts an already-populated target" test failed (`git.init` got called despite history being available on the target), then restored the correct ordering and reconfirmed all tests pass. Given the design doc explicitly calls this ordering "the task most likely to silently regress later," a test that merely happens to pass isn't enough — needed direct evidence it fails when the guarantee breaks.

Required mocking `../safMirrorBridge` too (not just `../gitfs`/`@capacitor/preferences`/`isomorphic-git`) — `initSyncRepo()` calls `pullFromTarget()` with no plugin argument, so it goes through the real default parameter, the `SafMirror` singleton, which needed redirecting to the test's fake tree.

## 9. Wire push into `syncNow()` — DONE

Completed the full per-cycle order the design doc's control flow specifies: `syncNow()` now also calls `pullFromTarget()` at the top (Android only) — not just once inside `initSyncRepo()`, which is a first-run-ordering concern, not a substitute for pulling on every cycle so this cycle's reconcile sees whatever arrived from other devices since last time — then the existing reconcile/commit run unchanged, then `pushToTarget()` after `commitNow()`. Both pull and push failures are caught and logged, never thrown, matching `initSyncRepo()`'s existing tolerance — reconcile/commit work against local data regardless of sync connectivity. `AndroidMirrorState` needs no separate update here beyond calling `pushToTarget()`/`pullFromTarget()` themselves — they already maintain their own state internally (tasks 6/7).

No dedicated unit test for this task specifically — its own stated completion criterion is task 10's integration tests, which exercise the full cycle this wiring enables. Verified via the existing 17-test suite (no regressions), `tsc --noEmit`, and a full `vite build`, all clean.

## 10. Integration tests — two-device convergence — DONE

Two fully independent "device" module instances (own `localFs`, own fake db, own mirror/device-id state, each via its own `vi.doMock()` registrations + `vi.resetModules()` + fresh dynamic import of `./gitSync`/`./androidMirror`) sharing one fake SAF tree, driving the real `syncNow()` cycle end to end — not just `androidMirror.ts`'s pull/push logic in isolation the way tasks 6a/7a did. All three scenarios from the design pass: device A creates, device B syncs and sees it; concurrent edits to different recipes converge on both without conflict; concurrent edits to the *same* recipe converge via LWW.

Two real bugs surfaced building this, both fixed rather than routed around:

1. **`readFile` didn't honor the `'utf8'` option.** `createFakeLocalFs()` (from tasks 6a/7a) always returned raw bytes; `reconcileEntity()` in `gitSync.ts` calls `readFile(path, 'utf8')` expecting a string back. `JSON.parse()` on a stringified byte array fails silently — caught by `reconcileEntity()`'s own "corrupt file, skip, retry next tick" handling, so nothing ever surfaced as an error, it just never reconciled. Fixed by making the fake mirror `gitfs.ts`'s real two-argument contract (`isUtf8Request` logic included) — this is a shared fake used by every test file, so the fix benefits tasks 6a/7a too even though they never happened to trigger it (`androidMirror.ts` itself never requests utf8 — only `gitSync.ts` does).

2. **Pull could silently discard a not-yet-pushed local edit** — see the design doc's "Correction found during implementation" note. This is the more consequential one: it meant the *same-recipe LWW* scenario didn't just fail to converge correctly, it converged on the wrong device's data. Fixed in `pullJsonDirectory()` by comparing `updated_at` before overwriting `recipes/`/`ingredients/` files (not `devices/`, which doesn't need it — see the design doc). Added two new dedicated pull tests (6a) for this specifically, alongside the integration-level coverage here.

Both fixes were verified the same way as task 8a's ordering test: temporarily disabled each one, confirmed the relevant test(s) failed as expected (not just "still green by luck"), then restored the fix and reconfirmed the full 22-test suite passes.

Also needed to mock `isomorphic-git` itself in this test file (not just `../gitfs`/`@capacitor/preferences`/`../safMirrorBridge`/`../../db/local`) — real `git.init`/`commit`/`resolveRef`/`statusMatrix` need a fully spec-compliant fs (proper `Stats` objects, `ENOENT` codes) that `createFakeLocalFs()` was never built to provide, and building that fidelity would have mostly re-tested git plumbing tasks 6a/7a/8a already cover. The mock operates at the same level as `gitSync.pullBeforeInit.test.ts`'s: `resolveRef` succeeds iff a local ref file exists, `init`/`commit` write a plausible ref, `statusMatrix` always reports a change. What's real: `reconcileEntity()`/`upsertFlatRow()`/the LWW comparisons — the actual logic this task exists to verify.

Extended `testUtils/fakes.ts` with `createFakeDb()` — routes by matching the small, fixed set of SQL templates `gitSync.ts` actually generates (the recipes/ingredients upsert, the `updated_at` LWW `SELECT`, and no-op handling for the `recipe_ingredients`/`recipe_steps`/`recipe_tools` child-table calls `reconcileRecipeChildren()` always issues) rather than a real SQL engine — throws on anything unrecognized so a future change to those templates fails loudly here instead of silently no-op'ing.

## 11. Device registry — DONE

Added `@capacitor/device` as a new dependency (`^8.0.3`, matching the other `@capacitor/*` packages' major version) and ran `npx cap sync android` to regenerate `capacitor.settings.gradle`/`capacitor.build.gradle` with it — those two files are Capacitor-generated and get overwritten on every `cap sync`/`cap update`, so hand-editing them wasn't an option.

`gitSync.ts` gained `DeviceRecord`, `writeDeviceRecord()` (private — writes only this device's own `devices/<id>.json`, never another's), and a `getDeviceName()`/`setDeviceName()` pair mirroring the existing `getDeviceId()` pattern: a user-set override (`Preferences`, for task 12's Account.tsx field to write to) wins if present, otherwise `@capacitor/device`'s `Device.getInfo().model`, otherwise the anonymous `device-xxxxxxxx` id itself — the exact fallback chain the design doc specifies. `writeDeviceRecord()` is called inside `syncNow()` right after `commitNow()` and before Android's `pushToTarget()` (so push picks up a fresh file the same cycle), on both platforms — Electron writes straight into its shared folder since there's no separate mirror step there, matching how it already handles `recipes/`/`ingredients/`. Not committed to git: `commitNow()` still only stages `recipes`/`ingredients`, since (per the design doc) each device only ever writes its own file, so there's no merge/history need for it — it's always-fresh state, not history. `androidMirror.ts`'s push/pull of `devices/<id>.json` (already built in tasks 6/7) needed no changes — it was already reading/writing whatever's at that local path; this task is what actually puts real content there.

One deliberate choice worth recording: `@capacitor/device` is imported *dynamically* inside `getDeviceName()`, not statically at module scope. Vitest's environment is plain Node (`vitest.config.ts`: `environment: "node"`), with no `navigator` global — `@capacitor/device`'s web fallback implementation throws `unavailable('Device API not available in this browser')` from `getInfo()` without one. None of the four existing test files mock `@capacitor/device`, and adding a mock to all of them (or making test authors remember to add one to every future test that touches `gitSync.ts`) seemed like exactly the kind of test-only ceremony the codebase has been avoiding elsewhere in this plan. A dynamic import inside a `try/catch` that falls back to the device id sidesteps that entirely — real behavior in an actual browser/WebView (where `navigator.userAgent` exists) is unaffected, and the Node-environment failure path *is* the correct fallback, not a workaround around it.

**Done when — verified:** extended `androidMirror.convergence.test.ts` (task 10's two-device harness) with a new `describe('device registry (task 11)')` block: after both devices call `syncNow()`, each one's `devices/<id>.json` exists on the shared fake tree with `deviceId`/`platform` matching and a `lastSyncAt` at or after the moment the test started; a second sync cycle for device A refreshes only A's record (`lastSyncAt` moves forward) while B's stays byte-for-byte unchanged. Verified the same way as tasks 8a/10: temporarily commented out the `writeDeviceRecord()` call in `syncNow()`, reran the suite, confirmed the new test failed (`JSON.parse("undefined")` — the file was never written), then restored it and reconfirmed all 23 tests pass. Also clean: `tsc --noEmit`, `vite build`.

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
