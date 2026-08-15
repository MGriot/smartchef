import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSafTree, putText, createFakeLocalFs } from './testUtils/fakes';

// This test exists specifically to guard the ordering the design doc calls
// out as correctness-critical: initSyncRepo() must pull from the SAF
// target BEFORE deciding whether to git.init a fresh repo, or a device
// joining an already-populated target would git.init a disconnected empty
// history instead of adopting the real one. Meant to stay in the suite
// permanently, not be a one-off validation — this exact ordering is easy
// to accidentally break in a future refactor.

const prefsStore = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefsStore.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefsStore.set(key, value);
    },
  },
}));

const localFs = createFakeLocalFs();
vi.mock('../gitfs', () => ({
  gitfs: localFs,
  getSyncBasePath: async () => '/private',
  ensureSyncFolderPermission: async () => {},
  base64ToBytes: (b64: string) => new Uint8Array(Buffer.from(b64, 'base64')),
  bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
}));

vi.mock('../electronBridge', () => ({
  isElectron: () => false,
}));

// initSyncRepo() calls pullFromTarget() with no arguments, so it goes
// through the real default parameter — the SafMirror singleton exported
// from safMirrorBridge.ts. Mocking that module is what actually lets this
// test's fake tree reach it, rather than pullFromTarget() silently talking
// to Capacitor's real (unavailable-in-Node) plugin bridge.
const tree = createFakeSafTree('fake://tree');
vi.mock('../safMirrorBridge', () => ({
  SafMirror: tree.plugin,
}));

// Real isomorphic-git needs real zlib-compressed git objects to resolve a
// ref against — not worth reproducing here. resolveRef's mock instead
// mirrors the one real-world fact this test actually depends on: it
// succeeds iff a local refs/heads/main file exists, exactly what a
// successful pullFromTarget() is supposed to have written before this
// check runs. init is a plain spy — the test's actual assertion is that
// it's never called.
const gitInit = vi.fn(async () => {});
function normalize(path: string): string {
  return path.replace(/^\/+/, '');
}
vi.mock('isomorphic-git', () => ({
  resolveRef: async ({ dir }: { dir: string }) => {
    if (!localFs.files.has(normalize(`${dir}/.git/refs/heads/main`))) {
      throw new Error('ENOENT: refs/heads/main not found');
    }
    return 'resolved-oid';
  },
  init: gitInit,
}));

let initSyncRepo: typeof import('./gitSync').initSyncRepo;
let setMirrorTree: typeof import('./androidMirror').setMirrorTree;

beforeEach(async () => {
  prefsStore.clear();
  localFs.files.clear();
  tree.files.clear();
  gitInit.mockClear();
  vi.resetModules();
  ({ initSyncRepo } = await import('./gitSync'));
  ({ setMirrorTree } = await import('./androidMirror'));
});

describe('initSyncRepo — pull-before-init ordering', () => {
  it('adopts an already-populated target instead of git.init-ing a disconnected history', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    putText(tree, '.git/refs/heads/main', 'commit-abc123\n');
    putText(tree, '.git/HEAD', 'ref: refs/heads/main\n');
    putText(tree, '.git/objects/ab/cdef01', 'object-bytes');

    await initSyncRepo();

    expect(gitInit).not.toHaveBeenCalled();
    expect(localFs.files.has('private/.git/refs/heads/main')).toBe(true);
  });

  it('still git.inits a fresh repo when the target has no history yet (true first device)', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    // Deliberately not seeding the tree with any refs/objects — this is
    // what a brand-new, never-synced-to target looks like.

    await initSyncRepo();

    expect(gitInit).toHaveBeenCalledTimes(1);
  });

  it('still git.inits when standalone mode has no SAF tree configured at all', async () => {
    // No setMirrorTree() call — matches every user of this feature before
    // task 12's onboarding UI exists, and anyone who skipped folder setup.
    await initSyncRepo();

    expect(gitInit).toHaveBeenCalledTimes(1);
  });
});
