import { describe, it, expect, vi } from 'vitest';
import { createFakeSafTree, createFakeLocalFs } from './testUtils/fakes';
import type { SafMirrorPlugin } from '../safMirrorBridge';

// Exercises gitSync.ts's new object/ref-transport sync cycle (rewritten for
// the standalone-storage-sync map's architecture) rather than the
// superseded androidMirror.ts pushToTarget()/pullFromTarget() call chain —
// but the pause-reason state itself (androidMirror.ts's
// getSyncPauseReason()/setSyncPauseReason(), read by Account.tsx's "sync
// paused" banner) predates that rewrite and still needs to light up on a
// real transport failure here.
//
// resolveRef is mocked to ignore which ref is asked for and always report
// "resolved-oid" once *some* refs/heads/main file exists locally — this
// collapses local HEAD and the remote-tracking ref to the same oid
// whenever both exist, so this test never drives Structured Merge
// (mergeBridge.ts, and by extension services/conflicts.local.ts's real
// SQLite-backed module) — deliberately out of scope here, already covered
// by mergeBridge.test.ts's own mocks.
vi.mock('isomorphic-git', () => ({
  resolveRef: async ({ fs, dir }: { fs: { promises: { stat: (p: string) => Promise<unknown> } }; dir: string }) => {
    await fs.promises.stat(`${dir}/.git/refs/heads/main`);
    return 'resolved-oid';
  },
  init: async ({ fs, gitdir }: { fs: { promises: { writeFile: (p: string, d: string) => Promise<void> } }; gitdir: string }) => {
    await fs.promises.writeFile(`${gitdir}/HEAD`, 'ref: refs/heads/main\n');
  },
  add: async () => {},
  commit: async ({
    fs,
    gitdir,
  }: {
    fs: { promises: { writeFile: (p: string, d: string) => Promise<void> } };
    gitdir: string;
  }) => {
    const oid = `commit-${Math.random().toString(36).slice(2)}`;
    await fs.promises.writeFile(`${gitdir}/refs/heads/main`, `${oid}\n`);
    return oid;
  },
  statusMatrix: async () => [['recipes/placeholder.json', 1, 2, 1]],
}));

describe('sync pause state (task 13)', () => {
  it('a transport failure sets the paused state without syncNow() throwing, and recovery clears it', async () => {
    const tree = createFakeSafTree('fake://target');
    const localFs = createFakeLocalFs();
    const prefsStore = new Map<string, string>();

    vi.doMock('@capacitor/preferences', () => ({
      Preferences: {
        get: async ({ key }: { key: string }) => ({ value: prefsStore.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
          prefsStore.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
          prefsStore.delete(key);
        },
      },
    }));
    vi.doMock('../gitfs', () => ({
      gitfs: localFs,
      getSyncBasePath: async () => '/private',
      ensureSyncFolderPermission: async () => {},
      base64ToBytes: (b64: string) => new Uint8Array(Buffer.from(b64, 'base64')),
      bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    }));
    vi.doMock('../electronBridge', () => ({ isElectron: () => false }));

    // Fails every write from the moment `revoked` flips true — simulating
    // permission being revoked partway through a sync cycle (provider
    // uninstalled, URI permission externally revoked, app storage cleared).
    // Reads stay healthy, matching how SAF permission loss actually
    // presents (an already-open document tree can still be listed/read for
    // a while after write access is pulled).
    let revoked = false;
    const flakyPlugin: SafMirrorPlugin = {
      ...tree.plugin,
      writeFile: async (opts) => {
        if (revoked) throw new Error('EACCES: permission denied (revoked)');
        return tree.plugin.writeFile(opts);
      },
    };
    vi.doMock('../safMirrorBridge', () => ({ SafMirror: flakyPlugin }));

    vi.resetModules();
    const gitSync = await import('./gitSync');
    const androidMirror = await import('./androidMirror');
    await androidMirror.setMirrorTree(tree.uri, 'Fake');

    // Establish a clean baseline cycle first, so the second cycle's failure
    // is a genuine "went from working to not," matching the design doc's
    // "permission lost" scenario rather than "never configured."
    await gitSync.writeEntityFile('recipes', 'r1', { id: 'r1', title: 'Soup', updated_at: '2026-01-01T00:00:00.000Z' });
    await gitSync.syncNow();
    expect(await androidMirror.getSyncPauseReason()).toBeNull();

    revoked = true;
    await gitSync.writeEntityFile('recipes', 'r2', { id: 'r2', title: 'Stew', updated_at: '2026-01-02T00:00:00.000Z' });

    await expect(gitSync.syncNow()).resolves.toBeDefined(); // must not throw

    expect(await androidMirror.getSyncPauseReason()).toMatch(/permission denied/);

    // Recovery: once the target is reachable again, the next successful
    // cycle should clear the paused state on its own (not just via a
    // "Change Folder" re-pick).
    revoked = false;
    await gitSync.syncNow();
    expect(await androidMirror.getSyncPauseReason()).toBeNull();
  });
});
