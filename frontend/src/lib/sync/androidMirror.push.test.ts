import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSafTree, getText, createFakeLocalFs, putLocalText } from './testUtils/fakes';

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
  base64ToBytes: (b64: string) => new Uint8Array(Buffer.from(b64, 'base64')),
  bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
}));

// androidMirror.ts keeps its own knownPushedObjects cache in a
// module-level variable, not just in the (per-test-cleared) prefsStore —
// so clearing prefsStore alone isn't enough isolation between tests;
// vi.resetModules() + re-importing is what actually gives each test a
// fresh module instance, same as a real app-restart would.
let pushToTarget: typeof import('./androidMirror').pushToTarget;
let setMirrorTree: typeof import('./androidMirror').setMirrorTree;
let getMirrorState: typeof import('./androidMirror').getMirrorState;
let getDeviceId: typeof import('./gitSync').getDeviceId;

beforeEach(async () => {
  prefsStore.clear();
  localFs.files.clear();
  vi.resetModules();
  ({ pushToTarget, setMirrorTree, getMirrorState } = await import('./androidMirror'));
  ({ getDeviceId } = await import('./gitSync'));
});

describe('pushToTarget', () => {
  it('does nothing when no tree has been configured yet', async () => {
    const result = await pushToTarget(createFakeSafTree().plugin);
    expect(result).toEqual({ pushed: false, objectsUploaded: 0 });
  });

  it('uploads objects before refs/HEAD — call order, not just end state', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putLocalText(localFs, '/private/.git/objects/ab/cdef01', 'object-bytes');
    putLocalText(localFs, '/private/.git/refs/heads/main', 'commit-abc123\n');
    putLocalText(localFs, '/private/.git/HEAD', 'ref: refs/heads/main\n');

    const writeSpy = vi.spyOn(tree.plugin, 'writeFile');
    await pushToTarget(tree.plugin);

    const paths = writeSpy.mock.calls.map((call) => call[0].path);
    const objectIndex = paths.indexOf('.git/objects/ab/cdef01');
    const refIndex = paths.indexOf('.git/refs/heads/main');
    const headIndex = paths.indexOf('.git/HEAD');

    expect(objectIndex).toBeGreaterThanOrEqual(0);
    expect(objectIndex).toBeLessThan(refIndex);
    expect(objectIndex).toBeLessThan(headIndex);
  });

  it('uploads local objects, refs/HEAD, and JSON payload', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putLocalText(localFs, '/private/.git/objects/ab/cdef01', 'object-bytes');
    putLocalText(localFs, '/private/.git/refs/heads/main', 'commit-abc123\n');
    putLocalText(localFs, '/private/.git/HEAD', 'ref: refs/heads/main\n');
    putLocalText(localFs, '/private/recipes/r1.json', '{"id":"r1"}');
    putLocalText(localFs, '/private/ingredients/i1.json', '{"id":"i1"}');

    const result = await pushToTarget(tree.plugin);

    expect(result.pushed).toBe(true);
    expect(result.objectsUploaded).toBe(1);
    expect(getText(tree, '.git/objects/ab/cdef01')).toBe('object-bytes');
    expect(getText(tree, '.git/refs/heads/main')).toBe('commit-abc123\n');
    expect(getText(tree, '.git/HEAD')).toBe('ref: refs/heads/main\n');
    expect(getText(tree, 'recipes/r1.json')).toBe('{"id":"r1"}');
    expect(getText(tree, 'ingredients/i1.json')).toBe('{"id":"i1"}');
  });

  it('never re-uploads an object already known to be on the target', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putLocalText(localFs, '/private/.git/objects/ab/cdef01', 'object-bytes');
    putLocalText(localFs, '/private/.git/refs/heads/main', 'commit-abc123\n');

    // First push uploads it and remembers it...
    await pushToTarget(tree.plugin);
    const writeSpy = vi.spyOn(tree.plugin, 'writeFile');
    // ...second push (nothing local changed) must skip it.
    const result = await pushToTarget(tree.plugin);

    expect(result.objectsUploaded).toBe(0);
    expect(writeSpy).not.toHaveBeenCalledWith(expect.objectContaining({ path: '.git/objects/ab/cdef01' }));
  });

  it('writes only its own devices/<id>.json, never another device\'s', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putLocalText(localFs, '/private/.git/refs/heads/main', 'commit-abc123\n');
    const myId = await getDeviceId();
    putLocalText(localFs, `/private/devices/${myId}.json`, `{"deviceId":"${myId}"}`);

    const writeSpy = vi.spyOn(tree.plugin, 'writeFile');
    await pushToTarget(tree.plugin);

    const devicePaths = writeSpy.mock.calls.map((call) => call[0].path).filter((p) => p.startsWith('devices/'));
    expect(devicePaths).toEqual([`devices/${myId}.json`]);
  });

  it('a failure partway through the objects loop never reaches refs — target stays consistent for a later pull', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putLocalText(localFs, '/private/.git/objects/aa/first01', 'first-object');
    putLocalText(localFs, '/private/.git/objects/bb/second02', 'second-object');
    putLocalText(localFs, '/private/.git/refs/heads/main', 'commit-abc123\n');

    let call = 0;
    vi.spyOn(tree.plugin, 'writeFile').mockImplementation(async (opts) => {
      call++;
      if (call === 2) throw new Error('simulated SAF write failure');
      tree.files.set(opts.path, new TextEncoder().encode(opts.data));
    });

    await expect(pushToTarget(tree.plugin)).rejects.toThrow('simulated SAF write failure');

    // refs/heads/main must never have been written — a puller reading the
    // target afterward sees exactly what it saw before this push attempt,
    // not a ref pointing at an object set that only partially arrived.
    expect(tree.files.has('.git/refs/heads/main')).toBe(false);
  });

  it('remembers an object that succeeded before a later failure, so a retry does not re-upload it', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putLocalText(localFs, '/private/.git/objects/aa/first01', 'first-object');
    putLocalText(localFs, '/private/.git/objects/bb/second02', 'second-object');
    putLocalText(localFs, '/private/.git/refs/heads/main', 'commit-abc123\n');

    let call = 0;
    vi.spyOn(tree.plugin, 'writeFile').mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error('simulated SAF write failure');
    });

    await expect(pushToTarget(tree.plugin)).rejects.toThrow();

    const state = await getMirrorState();
    const rememberedOneObject = state!.knownPushedObjects.length === 1;
    expect(rememberedOneObject).toBe(true);
  });
});
