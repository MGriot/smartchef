# Android Folder-Sync Parity — Progress Tracker

Live checklist for tasks 11-15 of [the plan](./2026-08-15-android-folder-sync-parity-plan.md).
Tasks 1-10 are done and committed (see plan doc + git log). Update this file
as steps complete so work can resume from here after an interruption —
the plan doc itself only gets its "## N. ... — DONE" write-up once a task
is fully finished and verified.

## Task 11 — Device registry

- [x] Add `@capacitor/device` to `frontend/package.json` deps, `npm install`
- [x] Run `npx cap sync android` to regenerate `capacitor.settings.gradle` /
      `capacitor.build.gradle` with the new plugin
- [x] Add `DEVICE_NAME_KEY`, `getDeviceName()`, `setDeviceName()` to `gitSync.ts`
- [x] Add `DeviceRecord` interface + `writeDeviceRecord()` to `gitSync.ts`
- [x] Wire `writeDeviceRecord()` into `syncNow()` (both platforms, after
      `commitNow()`, before Android's `pushToTarget()`)
- [x] `npx tsc --noEmit` clean
- [x] `npm test` — full suite still green (22/22, no regressions in tasks 6a/7a/8a/10)
- [x] Extend `androidMirror.convergence.test.ts` to assert
      `devices/<id>.json` exists on the shared fake tree after a sync cycle,
      with a fresh `lastSyncAt`, for both devices — plus a second-cycle
      check that A's refresh never disturbs B's file
- [x] Verified the new test actually catches the regression: temporarily
      disabled the `writeDeviceRecord()` call, confirmed it fails, restored
- [x] `vite build` clean
- [x] Write up the "## 11. Device registry — DONE" section in the plan doc
      (implementation notes, any deviations/findings, verification done)
- [x] Commit (cc81fee)

**Task 11: DONE.**

## Task 12 — Account.tsx: folder picker parity + device list + paused-sync state

Was blocked on task 13 (needs a real paused state to surface) — did task 13
first, out of plan-doc order (see task 13's note below and the plan doc).

- [x] Add `listDeviceRecords()` to `gitSync.ts` (reads `devices/*.json`,
      skips corrupt files, sorted newest-first) — shared with task 14
- [x] Remove the `isElectron()` gate on "Change Folder"; Android branch
      calls `pickTree()` + `setMirrorTree()`, then syncs immediately
- [x] "Sync Folder" display: `getSyncBasePath()` on Electron,
      `getMirrorState().treeDisplayName` on Android
- [x] Editable "Device Name" field → `setDeviceName()`, save-on-blur,
      triggers an immediate sync
- [x] "Known Devices" list using `listDeviceRecords()`
- [x] Paused-state banner (Android-only, `getSyncPauseReason()`) pointing at
      "Change Folder" as the recovery path
- [x] `tsc --noEmit` clean, `vite build` clean, full test suite still green
- [x] Plan doc write-up (marked IMPLEMENTED, not DONE — see below)
- [ ] **Manual verification on a real Android device/emulator and a
      packaged Electron build** — not possible from this sandbox (no
      device/emulator, no packaged shell, and `FolderSyncCard` only renders
      in standalone mode, which needs the native SQLite plugin a bare
      browser dev server doesn't have). This is the same kind of gap task
      15 already exists to cover — flagging it here rather than claiming
      the done-when criterion (manual verification) is satisfied when it
      isn't.
- [x] Commit `gitSync.ts`'s `listDeviceRecords()` (clean/isolated diff)
- [ ] **`Account.tsx` is NOT committed.** Its working-tree diff against HEAD
      is the *entire* `FolderSyncCard`/`DeviceRecord` region plus a large
      amount of other pre-existing, never-committed work from earlier in
      this branch (standalone-mode UI, LLM provider card, etc. — none of it
      authored this session, none of it part of the SAF-sync-parity plan),
      interleaved in the same functions with no clean seam to split my
      edit out along. Sweeping all of that into a task-12 commit would
      misrepresent whose work it is and bloat this plan's history with
      unrelated changes. Left as an uncommitted edit for the user to review
      and commit (with the rest of that pre-existing Account.tsx work, or
      separately) on their own terms.

**Task 12: code complete, manual verification outstanding — see task 15.
`gitSync.ts` piece committed; `Account.tsx` piece deliberately left
uncommitted (see above).**

## Task 13 — Permission-lost error handling

- [x] `androidMirror.ts`: add `getSyncPauseReason()` + internal
      `setSyncPauseReason()`, backed by `Preferences` (new key)
- [x] Wrap `pullFromTarget()`/`pushToTarget()`'s risky-call sections: catch,
      record the pause reason, then **re-throw** (existing 7a unit tests
      assert `pushToTarget()` rejects on a mid-loop failure — confirmed
      still true) — `gitSync.ts`'s existing `.catch(warn)` in `syncNow()`
      is what actually keeps `syncNow()` from throwing, unchanged
- [x] Clear the pause reason on the next successful pull/push (self-healing,
      not just via "Change Folder") — asserted in the new test's recovery case
- [x] Add `remove` to the `@capacitor/preferences` mock in all 4 test files
      that only mocked `get`/`set` (pull.test.ts, push.test.ts,
      gitSync.pullBeforeInit.test.ts, convergence.test.ts's `vi.doMock`)
- [x] New `androidMirror.syncPause.test.ts`: simulates a plugin write
      failure mid-`syncNow()`-cycle, confirms `syncNow()` resolves (doesn't
      throw), the local write still reaches "SQLite" (the fake db),
      `getSyncPauseReason()` is set, and a later successful cycle clears it
- [x] Verified the new test actually catches the regression: commented out
      the `setSyncPauseReason()` call in `pushToTarget()`'s catch, confirmed
      the test failed, restored
- [x] Full suite green (24/24), `tsc --noEmit` clean, `vite build` clean
- [x] Plan doc write-up
- [x] Commit (99d863a)

**Task 13: DONE.**

## Task 14 — SyncHistory.tsx: show device registry alongside commit history
Not started.

## Task 15 — Manual device QA
Not started (requires real hardware — see plan doc).
