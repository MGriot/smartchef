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
- [ ] Commit

## Task 12 — Account.tsx: folder picker parity + device list + paused-sync state
Not started.

## Task 13 — Permission-lost error handling
Not started.

## Task 14 — SyncHistory.tsx: show device registry alongside commit history
Not started.

## Task 15 — Manual device QA
Not started (requires real hardware — see plan doc).
