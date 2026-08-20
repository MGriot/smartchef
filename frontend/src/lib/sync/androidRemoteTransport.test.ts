import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeSafTree, putText, getText } from './testUtils/fakes';

const prefsStore = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefsStore.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => { prefsStore.set(key, value); },
    remove: async ({ key }: { key: string }) => { prefsStore.delete(key); },
  },
}));

vi.mock('../gitfs', () => ({
  base64ToBytes: (b64: string) => new Uint8Array(Buffer.from(b64, 'base64')),
  bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
}));

let createAndroidRemoteTransport: typeof import('./androidRemoteTransport').createAndroidRemoteTransport;

beforeEach(async () => {
  prefsStore.clear();
  vi.resetModules();
  ({ createAndroidRemoteTransport } = await import('./androidRemoteTransport'));
});

describe('createAndroidRemoteTransport', () => {
  it('reads and writes files through the SafMirror plugin', async () => {
    const tree = createFakeSafTree('fake://tree');
    const transport = createAndroidRemoteTransport('fake://tree', tree.plugin);

    await transport.writeFile('.git/objects/ab/cdef01', new TextEncoder().encode('object-bytes'));

    expect(getText(tree, '.git/objects/ab/cdef01')).toBe('object-bytes');
    expect(await transport.readFile('.git/objects/ab/cdef01')).toEqual(new TextEncoder().encode('object-bytes'));
  });

  it('exists() is true for a present file, false for a missing one', async () => {
    const tree = createFakeSafTree('fake://tree');
    putText(tree, '.git/refs/heads/main', 'commit-abc\n');
    const transport = createAndroidRemoteTransport('fake://tree', tree.plugin);

    expect(await transport.exists('.git/refs/heads/main')).toBe(true);
    expect(await transport.exists('.git/refs/heads/does-not-exist')).toBe(false);
  });

  it('listDir returns entry names, [] for a missing directory', async () => {
    const tree = createFakeSafTree('fake://tree');
    putText(tree, '.git/objects/ab/cdef01', 'x');
    putText(tree, '.git/objects/ab/aaaa02', 'y');
    const transport = createAndroidRemoteTransport('fake://tree', tree.plugin);

    expect((await transport.listDir('.git/objects/ab')).sort()).toEqual(['aaaa02', 'cdef01']);
    expect(await transport.listDir('.git/objects/does-not-exist')).toEqual([]);
  });

  it('caches a confirmed-existing object path so a second exists() check skips the SAF round-trip', async () => {
    const tree = createFakeSafTree('fake://tree');
    putText(tree, '.git/objects/ab/cdef01', 'x');
    const transport = createAndroidRemoteTransport('fake://tree', tree.plugin);
    await transport.exists('.git/objects/ab/cdef01'); // first check, populates the cache

    const readSpy = vi.spyOn(tree.plugin, 'readFile');
    const result = await transport.exists('.git/objects/ab/cdef01');

    expect(result).toBe(true);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('remembers an object as known immediately after writing it, without a separate exists() round-trip', async () => {
    const tree = createFakeSafTree('fake://tree');
    const transport = createAndroidRemoteTransport('fake://tree', tree.plugin);
    await transport.writeFile('.git/objects/ab/cdef01', new TextEncoder().encode('x'));

    const readSpy = vi.spyOn(tree.plugin, 'readFile');
    expect(await transport.exists('.git/objects/ab/cdef01')).toBe(true);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('never caches ref/HEAD paths — those change every commit, must always be checked live', async () => {
    const tree = createFakeSafTree('fake://tree');
    putText(tree, '.git/refs/heads/main', 'commit-abc\n');
    const transport = createAndroidRemoteTransport('fake://tree', tree.plugin);
    await transport.exists('.git/refs/heads/main');

    const readSpy = vi.spyOn(tree.plugin, 'readFile');
    await transport.exists('.git/refs/heads/main');

    expect(readSpy).toHaveBeenCalled();
  });
});
