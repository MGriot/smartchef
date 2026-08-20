import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeLocalFs, putLocalText, getLocalText } from './testUtils/fakes';

const remoteFs = createFakeLocalFs();
vi.mock('../electronBridge', () => ({
  electronFs: () => ({
    readFile: remoteFs.promises.readFile,
    writeFile: remoteFs.promises.writeFile,
    readdir: remoteFs.promises.readdir,
    stat: remoteFs.promises.stat,
  }),
}));
vi.mock('../gitfs', () => ({ getElectronFolder: async () => '/chosen-folder' }));

let createElectronRemoteTransport: typeof import('./electronRemoteTransport').createElectronRemoteTransport;

beforeEach(async () => {
  remoteFs.files.clear();
  vi.resetModules();
  ({ createElectronRemoteTransport } = await import('./electronRemoteTransport'));
});

describe('createElectronRemoteTransport', () => {
  it('resolves paths against the chosen Sync Folder root (no subfolder)', async () => {
    const transport = await createElectronRemoteTransport();
    await transport.writeFile('.git/objects/ab/cdef01', new TextEncoder().encode('object-bytes'));

    expect(getLocalText(remoteFs, '/chosen-folder/.git/objects/ab/cdef01')).toBe('object-bytes');
  });

  it('reads back what was written', async () => {
    const transport = await createElectronRemoteTransport();
    await transport.writeFile('.git/refs/heads/main', new TextEncoder().encode('commit-abc\n'));

    expect(await transport.readFile('.git/refs/heads/main')).toEqual(new TextEncoder().encode('commit-abc\n'));
  });

  it('exists() is true for a present file, false for a missing one', async () => {
    putLocalText(remoteFs, '/chosen-folder/.git/refs/heads/main', 'commit-abc\n');
    const transport = await createElectronRemoteTransport();

    expect(await transport.exists('.git/refs/heads/main')).toBe(true);
    expect(await transport.exists('.git/refs/heads/does-not-exist')).toBe(false);
  });

  it('listDir returns entry names, [] for a missing directory', async () => {
    putLocalText(remoteFs, '/chosen-folder/.git/objects/ab/cdef01', 'x');
    const transport = await createElectronRemoteTransport();

    expect(await transport.listDir('.git/objects/ab')).toEqual(['cdef01']);
    expect(await transport.listDir('.git/objects/does-not-exist')).toEqual([]);
  });
});
