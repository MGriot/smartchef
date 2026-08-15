import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSafTree, putText } from './testUtils/fakes';

// androidMirror.ts's own state (AndroidMirrorState) lives in
// @capacitor/preferences — fake it with a plain in-memory map.
const prefsStore = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefsStore.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefsStore.set(key, value);
    },
  },
}));

// The private working copy androidMirror.ts reads/writes via
// gitfs.promises + getSyncBasePath() — faked the same way, a flat map
// keyed by normalized path.
const localFiles = new Map<string, Uint8Array>();
function normalize(path: string): string {
  return path.replace(/^\/+/, '');
}
vi.mock('../gitfs', () => ({
  gitfs: {
    promises: {
      stat: async (path: string) => {
        if (!localFiles.has(normalize(path))) throw new Error('ENOENT');
        return {};
      },
      writeFile: async (path: string, data: Uint8Array) => {
        localFiles.set(normalize(path), data);
      },
      readFile: async (path: string) => {
        const bytes = localFiles.get(normalize(path));
        if (!bytes) throw new Error('ENOENT');
        return bytes;
      },
    },
  },
  getSyncBasePath: async () => '/private',
  base64ToBytes: (b64: string) => new Uint8Array(Buffer.from(b64, 'base64')),
  bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
}));

const { pullFromTarget, setMirrorTree, getMirrorState } = await import('./androidMirror');

function localText(path: string): string | undefined {
  const bytes = localFiles.get(normalize(path));
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

beforeEach(() => {
  prefsStore.clear();
  localFiles.clear();
});

describe('pullFromTarget', () => {
  it('does nothing when no tree has been configured yet', async () => {
    const result = await pullFromTarget(createFakeSafTree().plugin);
    expect(result).toEqual({ pulled: false, objectsFetched: 0 });
  });

  it('does nothing when the target has no history yet (empty/new target)', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    const result = await pullFromTarget(tree.plugin);
    expect(result).toEqual({ pulled: false, objectsFetched: 0 });
  });

  it('fetches missing objects and writes refs/HEAD/JSON payload', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putText(tree, '.git/refs/heads/main', 'commit-abc123\n');
    putText(tree, '.git/HEAD', 'ref: refs/heads/main\n');
    putText(tree, '.git/objects/ab/cdef01', 'compressed-object-bytes');
    putText(tree, 'recipes/r1.json', '{"id":"r1","title":"Soup"}');
    putText(tree, 'devices/device-a.json', '{"deviceId":"device-a"}');

    const result = await pullFromTarget(tree.plugin);

    expect(result.pulled).toBe(true);
    expect(result.objectsFetched).toBe(1);
    expect(localText('/private/.git/refs/heads/main')).toBe('commit-abc123\n');
    expect(localText('/private/.git/HEAD')).toBe('ref: refs/heads/main\n');
    expect(localText('/private/.git/objects/ab/cdef01')).toBe('compressed-object-bytes');
    expect(localText('/private/recipes/r1.json')).toBe('{"id":"r1","title":"Soup"}');
    expect(localText('/private/devices/device-a.json')).toBe('{"deviceId":"device-a"}');
  });

  it('never re-fetches an object that already exists locally', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putText(tree, '.git/refs/heads/main', 'commit-abc123\n');
    putText(tree, '.git/objects/ab/cdef01', 'object-bytes');
    // Pretend we already have this exact object locally.
    localFiles.set('private/.git/objects/ab/cdef01', new TextEncoder().encode('object-bytes'));

    const readFileSpy = vi.spyOn(tree.plugin, 'readFile');
    const result = await pullFromTarget(tree.plugin);

    expect(result.objectsFetched).toBe(0);
    expect(readFileSpy).not.toHaveBeenCalledWith(expect.objectContaining({ path: '.git/objects/ab/cdef01' }));
  });

  it('always overwrites a changed JSON file rather than skipping it', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putText(tree, '.git/refs/heads/main', 'commit-abc123\n');
    putText(tree, 'recipes/r1.json', '{"id":"r1","title":"New Title"}');
    localFiles.set('private/recipes/r1.json', new TextEncoder().encode('{"id":"r1","title":"Stale Title"}'));

    await pullFromTarget(tree.plugin);

    expect(localText('/private/recipes/r1.json')).toBe('{"id":"r1","title":"New Title"}');
  });

  it('pulls every device registry file without treating any device specially', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putText(tree, '.git/refs/heads/main', 'commit-abc123\n');
    putText(tree, 'devices/device-a.json', '{"deviceId":"device-a"}');
    putText(tree, 'devices/device-b.json', '{"deviceId":"device-b"}');

    await pullFromTarget(tree.plugin);

    expect(localText('/private/devices/device-a.json')).toBe('{"deviceId":"device-a"}');
    expect(localText('/private/devices/device-b.json')).toBe('{"deviceId":"device-b"}');
  });

  it('remembers freshly-fetched objects so a later pull skips them too', async () => {
    await setMirrorTree('fake://tree', 'Fake');
    const tree = createFakeSafTree('fake://tree');
    putText(tree, '.git/refs/heads/main', 'commit-abc123\n');
    putText(tree, '.git/objects/ab/cdef01', 'object-bytes');

    await pullFromTarget(tree.plugin);
    const state = await getMirrorState();

    expect(state?.knownPushedObjects).toContain('.git/objects/ab/cdef01');
  });
});
