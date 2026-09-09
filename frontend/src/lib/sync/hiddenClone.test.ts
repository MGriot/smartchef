import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeLocalFs } from './testUtils/fakes';

const localFs = createFakeLocalFs();
vi.mock('../gitfs', () => ({ gitfs: localFs }));
vi.mock('../electronBridge', () => ({ isElectron: () => false, getHiddenCloneDir: async () => { throw new Error('not electron'); } }));

// Same style as gitSync.pullBeforeInit.test.ts: resolveRef succeeds iff a
// local refs/heads/main file exists, init is a plain spy — real
// isomorphic-git needs real zlib-compressed objects this test has no
// reason to reproduce.
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

let getHiddenCloneDir: typeof import('./hiddenClone').getHiddenCloneDir;
let ensureHiddenCloneInitialized: typeof import('./hiddenClone').ensureHiddenCloneInitialized;
let resetHiddenCloneInitFlag: typeof import('./hiddenClone').resetHiddenCloneInitFlag;

beforeEach(async () => {
  localFs.files.clear();
  gitInit.mockClear();
  vi.resetModules();
  ({ getHiddenCloneDir, ensureHiddenCloneInitialized, resetHiddenCloneInitFlag } = await import('./hiddenClone'));
});

describe('getHiddenCloneDir', () => {
  it('resolves to a fixed Android private-storage path, distinct from Local Storage and the old sync path', async () => {
    const dir = await getHiddenCloneDir();
    expect(dir).toBe('/sync-clone');
  });
});

describe('ensureHiddenCloneInitialized', () => {
  it('git.inits a fresh repo when none exists yet', async () => {
    const { dir, gitdir } = await ensureHiddenCloneInitialized();

    expect(gitInit).toHaveBeenCalledTimes(1);
    expect(dir).toBe('/sync-clone');
    expect(gitdir).toBe('/sync-clone/.git');
  });

  it('does not re-init when a repo already exists', async () => {
    localFs.files.set('sync-clone/.git/refs/heads/main', new TextEncoder().encode('commit-abc\n'));

    await ensureHiddenCloneInitialized();

    expect(gitInit).not.toHaveBeenCalled();
  });

  it('only initializes once per session — a second call is a no-op even without resolveRef re-checking', async () => {
    await ensureHiddenCloneInitialized();
    expect(gitInit).toHaveBeenCalledTimes(1);

    await ensureHiddenCloneInitialized();
    expect(gitInit).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it('resetHiddenCloneInitFlag() forces the next call to re-check', async () => {
    await ensureHiddenCloneInitialized();
    expect(gitInit).toHaveBeenCalledTimes(1);

    resetHiddenCloneInitFlag();
    localFs.files.set('sync-clone/.git/refs/heads/main', new TextEncoder().encode('commit-abc\n'));
    await ensureHiddenCloneInitialized();

    // Re-checked, found a real repo this time, so still didn't re-init.
    expect(gitInit).toHaveBeenCalledTimes(1);
  });
});
