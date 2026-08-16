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
Blocked on task 13 (needs a real paused state to surface) — **doing task 13
first**, out of plan-doc order. The plan doc lists 12 before 13, but 12's
own spec says "surface the paused state from task 13's error handling" —
building the UI to read a state that doesn't exist yet would mean
re-touching Account.tsx a second time once 13 lands. Not started.

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
- [ ] Commit

**Task 13: DONE** (pending commit).

## Task 14 — SyncHistory.tsx: show device registry alongside commit history
Not started.

## Task 15 — Manual device QA
Not started (requires real hardware — see plan doc).
