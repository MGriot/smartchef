// ════════════════════════════════════════════════════════════════════════
// The write half of the Android first-sync crash (the read half is covered
// by sync/nativeHttpClient.test.ts).
//
// After a fetch, isomorphic-git writes the packfile it received straight
// back through this module — so a first sync, which pulls the whole
// repository because it has no history to negotiate against, put ~16 MB
// through Filesystem.writeFile() in a single call: a ~22 MB base64 string,
// Capacitor's JSON serialization of it, and the native decode, all live at
// once. It also built that string one character at a time, which is
// quadratic and on its own enough to look like a hang.
//
// The subtle part of the fix is the slice size. Base64 encodes in 3-byte
// groups, so splitting anywhere that is not a multiple of 3 pads every
// piece but the last with `=` — and appending padded pieces yields a file
// that is longer than the input and wrong, with nothing throwing. These
// tests reassemble what the plugin was actually told to write and compare
// it byte for byte, which is the only way that class of bug shows up.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const writeFileMock = vi.fn();
const appendFileMock = vi.fn();
const renameMock = vi.fn();
const deleteFileMock = vi.fn();

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    writeFile: (...a: unknown[]) => writeFileMock(...a),
    appendFile: (...a: unknown[]) => appendFileMock(...a),
    rename: (...a: unknown[]) => renameMock(...a),
    deleteFile: (...a: unknown[]) => deleteFileMock(...a),
  },
}));
vi.mock('./electronBridge', () => ({
  isElectron: () => false,
  electronFs: () => {
    throw new Error('not the Electron path');
  },
}));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {} } }));

const { gitfs } = await import('./gitfs');

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Everything the plugin was handed, decoded and concatenated in call
 *  order — i.e. the bytes that actually landed on disk. */
function bytesWritten(): Uint8Array {
  const pieces = [
    ...writeFileMock.mock.calls.map((c) => (c[0] as { data: string }).data),
    ...appendFileMock.mock.calls.map((c) => (c[0] as { data: string }).data),
  ].map(base64ToBytes);
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of pieces) {
    merged.set(p, off);
    off += p.length;
  }
  return merged;
}

function firstMismatch(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function pseudoRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = seed & 0xff;
  }
  return bytes;
}

beforeEach(() => {
  writeFileMock.mockReset().mockResolvedValue(undefined);
  appendFileMock.mockReset().mockResolvedValue(undefined);
  renameMock.mockReset().mockResolvedValue(undefined);
  deleteFileMock.mockReset().mockResolvedValue(undefined);
});

describe('a small binary write', () => {
  it('still goes across in one call, at its final path', async () => {
    const bytes = pseudoRandomBytes(4096);

    await gitfs.promises.writeFile('.git/objects/ab/cdef', bytes);

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(appendFileMock).not.toHaveBeenCalled();
    expect(renameMock).not.toHaveBeenCalled();
    expect((writeFileMock.mock.calls[0][0] as { path: string }).path).not.toMatch(/\.part$/);
    expect(firstMismatch(bytesWritten(), bytes)).toBe(-1);
  });
});

describe('a packfile-sized binary write', () => {
  it('is split into bounded pieces that reassemble byte for byte', async () => {
    // Deliberately not a whole multiple of the chunk size, and not a
    // multiple of 3 overall, so both the short final piece and the
    // base64-padding trap are exercised.
    const bytes = pseudoRandomBytes(2 * 1024 * 1024 + 1025);

    await gitfs.promises.writeFile('.git/objects/pack/pack-abc.pack', bytes);

    expect(appendFileMock.mock.calls.length).toBeGreaterThan(0);
    const written = bytesWritten();
    expect(written.length).toBe(bytes.length);
    expect(firstMismatch(written, bytes)).toBe(-1);
  });

  it('keeps every piece under the chunk ceiling', async () => {
    const bytes = pseudoRandomBytes(3 * 1024 * 1024);

    await gitfs.promises.writeFile('.git/objects/pack/pack-abc.pack', bytes);

    const encoded = [
      ...writeFileMock.mock.calls.map((c) => (c[0] as { data: string }).data),
      ...appendFileMock.mock.calls.map((c) => (c[0] as { data: string }).data),
    ];
    for (const piece of encoded) {
      expect(base64ToBytes(piece).length).toBeLessThanOrEqual(768 * 1024);
    }
  });

  it('has no interior base64 padding, which is what silently corrupts an append', async () => {
    const bytes = pseudoRandomBytes(2 * 1024 * 1024);

    await gitfs.promises.writeFile('.git/objects/pack/pack-abc.pack', bytes);

    const encoded = [
      ...writeFileMock.mock.calls.map((c) => (c[0] as { data: string }).data),
      ...appendFileMock.mock.calls.map((c) => (c[0] as { data: string }).data),
    ];
    for (const piece of encoded.slice(0, -1)) {
      expect(piece.endsWith('=')).toBe(false);
    }
  });

  it('assembles under a .part name and renames onto the real path', async () => {
    const bytes = pseudoRandomBytes(2 * 1024 * 1024);

    await gitfs.promises.writeFile('.git/objects/pack/pack-abc.pack', bytes);

    const tmp = (writeFileMock.mock.calls[0][0] as { path: string }).path;
    expect(tmp).toMatch(/\.part$/);
    for (const call of appendFileMock.mock.calls) {
      expect((call[0] as { path: string }).path).toBe(tmp);
    }
    const rename = renameMock.mock.calls[0][0] as { from: string; to: string };
    expect(rename.from).toBe(tmp);
    expect(rename.to).toBe(tmp.replace(/\.part$/, ''));
  });

  it('leaves no .part behind when a piece fails mid-write', async () => {
    appendFileMock.mockRejectedValueOnce(new Error('ENOSPC'));

    await expect(
      gitfs.promises.writeFile('.git/objects/pack/pack-abc.pack', pseudoRandomBytes(3 * 1024 * 1024))
    ).rejects.toThrow('ENOSPC');

    // A truncated pack at the real path would be read later as corrupt
    // rather than missing, which is far harder to recover from.
    expect(renameMock).not.toHaveBeenCalled();
    const deleted = deleteFileMock.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(deleted.some((p) => p.endsWith('.part'))).toBe(true);
  });
});
