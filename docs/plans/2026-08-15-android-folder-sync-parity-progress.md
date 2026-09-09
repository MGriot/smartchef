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
- [x] Commit `Account.tsx` (`3cabbef`) — on closer inspection the diff was
      in fact a clean, self-contained addition (new `DeviceRecord`
      interface, one new `FolderSyncCard` component, one `<FolderSyncCard />`
      call site) with no interleaving, contrary to the earlier note here —
      committed on its own.

**Task 12: code complete and committed (`3cabbef` + `cc81fee`'s
`gitSync.ts` piece). Manual verification outstanding — see task 15.**

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

- [x] Add a "Devices" card above the commit list, using `listDeviceRecords()`
      (already committed in task 12's `gitSync.ts` piece)
- [x] Platform icon + device name + relative last-sync time per row, reusing
      this file's existing `formatWhen()`
- [x] `tsc --noEmit` clean, `vite build` clean, full test suite still green
- [x] Plan doc write-up (marked IMPLEMENTED, not DONE)
- [ ] **Manual verification** — same gap as task 12, see task 15
- [x] Committed (`9e2d37d`) — the whole file, since it was never committed
      before this session touched it (no baseline to split against). Commit
      message is explicit that only the "Devices" card is this session's
      task-14 work; the commit-history view itself predates this plan.
      Requires the `/sync-history` route + import already present in the
      working tree's `App.tsx`, not committed here (bundled with broader,
      unrelated standalone-mode bootstrap changes) — doesn't block using the
      page since the working tree already has that wiring either way.

**Task 14: code complete and committed (`9e2d37d`). Manual verification
outstanding, see task 15.**

## Task 15 — Manual device QA
Not started (requires real hardware — see plan doc). Now also covers
verifying tasks 12 and 14's UI, which this sandbox couldn't do.

## Summary of what's committed vs. not

Committed to `feat/cook-calendar-geolocation-and-cloud-llm-followups`
this session: `cc81fee`, `e680731`, `99d863a`, `e1f95dd`, `3cabbef`,
`9e2d37d` — tasks 11, 12, 13, and 14 all in full now. All
`frontend/src/lib/sync/*.ts`, `frontend/src/pages/Account.tsx`,
`frontend/src/pages/SyncHistory.tsx`, and their tests are committed.

Both `Account.tsx`'s `FolderSyncCard` and `SyncHistory.tsx` are
code-complete and pass `tsc --noEmit`/`vite build`/the full test suite, but
neither has been run in a real app yet — that's all that's left, task 15.

**Still not committed (out of scope for this plan, left for the user):**
`frontend/src/App.tsx`'s standalone-mode bootstrap changes (including the
`/sync-history` route + import needed for `SyncHistory.tsx` to be reachable
— already present in the working tree, just not yet committed), and the
broader standalone-mode/Electron work (`frontend/electron/`, `db/local.ts`,
`electronBridge.ts`, `standalone.ts`, `services/*.local.ts`, etc.) that
predates and is unrelated to the SAF-sync-parity plan itself.
