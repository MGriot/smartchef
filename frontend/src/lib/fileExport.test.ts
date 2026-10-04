// ════════════════════════════════════════════════════════════════════════
// lib/fileExport.ts — the one way every export reaches the user.
//
// Two things here are easy to get silently wrong and impossible to see
// from the UI:
//   - which platform path runs. Capacitor.isNativePlatform() is true on
//     Electron too, so the Electron check must come first, or the desktop
//     app would try to stage a file for an Android plugin it doesn't have.
//   - the Android staging. A library backup is tens of MB, and the point of
//     staging is that no single bridge call carries more than a slice of
//     it — while the slices, appended in order, still reassemble into
//     exactly the original text (no split surrogate pairs, nothing lost).
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

const platform = { native: false, name: 'web', electron: false, files: true };

const writeFileMock = vi.fn(async () => ({}));
const appendFileMock = vi.fn(async () => ({}));
const rmdirMock = vi.fn(async () => ({}));
const saveFileViaDialogMock = vi.fn(async () => 'C:\\Users\\me\\Documents\\x.json' as string | null);
const saveStagedFileMock = vi.fn(async () => ({ uri: 'content://x', displayName: 'x (1).json' }) as { uri: string; displayName: string } | null);
const shareStagedFileMock = vi.fn(async () => {});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
  },
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    writeFile: (...a: unknown[]) => writeFileMock(...(a as [])),
    appendFile: (...a: unknown[]) => appendFileMock(...(a as [])),
    rmdir: (...a: unknown[]) => rmdirMock(...(a as [])),
  },
}));
vi.mock('./electronBridge', () => ({
  isElectron: () => platform.electron,
  saveFileViaDialog: (...a: unknown[]) => saveFileViaDialogMock(...(a as [])),
}));
vi.mock('./filesBridge', () => ({
  hasNativeFiles: () => platform.files,
  saveStagedFile: (...a: unknown[]) => saveStagedFileMock(...(a as [])),
  shareStagedFile: (...a: unknown[]) => shareStagedFileMock(...(a as [])),
}));
vi.mock('./gitfs', () => ({
  bytesToBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
}));

const {
  saveExportFile, shareExportFile, canShareFiles, stageForNative, slugForFilename,
  STAGE_CHUNK_CHARS, STAGE_CHUNK_BYTES,
} = await import('./fileExport');

function setPlatform(p: Partial<typeof platform>) {
  Object.assign(platform, { native: false, name: 'web', electron: false, files: true }, p);
}

const writes = () => [
  ...writeFileMock.mock.calls.map(c => (c as unknown[])[0] as { path: string; data: string; encoding?: string }),
  ...appendFileMock.mock.calls.map(c => (c as unknown[])[0] as { path: string; data: string; encoding?: string }),
];

beforeEach(() => {
  vi.clearAllMocks();
  setPlatform({});
});

describe('saveExportFile — platform dispatch', () => {
  it('uses the Electron save dialog even though Capacitor reports native', () => {
    setPlatform({ native: true, name: 'electron', electron: true });
    return saveExportFile({ fileName: 'tart.smartchef.json', mimeType: 'application/json', data: '{}' }, { dialogTitle: 'Save' })
      .then(result => {
        expect(saveFileViaDialogMock).toHaveBeenCalledWith('tart.smartchef.json', '{}', {
          title: 'Save',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        expect(writeFileMock).not.toHaveBeenCalled();
        expect(result).toEqual({ kind: 'electron', location: 'C:\\Users\\me\\Documents\\x.json', fileName: 'tart.smartchef.json' });
      });
  });

  it('passes bytes to Electron untouched', async () => {
    setPlatform({ native: true, name: 'electron', electron: true });
    const bytes = new Uint8Array([1, 2, 3]);
    await saveExportFile({ fileName: 'a.pdf', mimeType: 'application/pdf', data: bytes });
    expect((saveFileViaDialogMock.mock.calls[0] as unknown[])[1]).toBe(bytes);
  });

  it('resolves null when the Electron dialog is cancelled', async () => {
    setPlatform({ native: true, name: 'electron', electron: true });
    saveFileViaDialogMock.mockResolvedValueOnce(null);
    expect(await saveExportFile({ fileName: 'a.json', mimeType: 'application/json', data: '{}' })).toBeNull();
  });

  it('stages the file and hands only its path to the Android plugin', async () => {
    setPlatform({ native: true, name: 'android' });
    const result = await saveExportFile({ fileName: 'tart.smartchef.json', mimeType: 'application/json', data: '{"a":1}' });
    expect(rmdirMock).toHaveBeenCalledWith({ path: 'exports', directory: 'CACHE', recursive: true });
    expect(saveStagedFileMock).toHaveBeenCalledWith({ path: 'exports/tart.smartchef.json', fileName: 'tart.smartchef.json', mimeType: 'application/json' });
    expect(result).toEqual({ kind: 'android', location: 'x (1).json', fileName: 'tart.smartchef.json' });
  });

  it('resolves null when the Android picker is cancelled', async () => {
    setPlatform({ native: true, name: 'android' });
    saveStagedFileMock.mockResolvedValueOnce(null);
    expect(await saveExportFile({ fileName: 'a.json', mimeType: 'application/json', data: '{}' })).toBeNull();
  });

  it('fails loudly on an Android build without the plugin rather than doing nothing', async () => {
    setPlatform({ native: true, name: 'android', files: false });
    await expect(saveExportFile({ fileName: 'a.json', mimeType: 'application/json', data: '{}' })).rejects.toThrow();
  });
});

describe('shareExportFile', () => {
  it('is only offered on Android', () => {
    expect(canShareFiles()).toBe(false);
    setPlatform({ native: true, name: 'electron', electron: true });
    expect(canShareFiles()).toBe(false);
    setPlatform({ native: true, name: 'android' });
    expect(canShareFiles()).toBe(true);
  });

  it('stages, then opens the share sheet with the path', async () => {
    setPlatform({ native: true, name: 'android' });
    await shareExportFile({ fileName: 'list.md', mimeType: 'text/markdown', data: '# list' }, 'Share file');
    expect(shareStagedFileMock).toHaveBeenCalledWith({ path: 'exports/list.md', fileName: 'list.md', mimeType: 'text/markdown', title: 'Share file' });
  });
});

describe('stageForNative — chunking', () => {
  it('never hands the bridge more than one slice, and reassembles exactly', async () => {
    const text = 'abc€'.repeat(Math.ceil((STAGE_CHUNK_CHARS * 2.5) / 4));
    await stageForNative({ fileName: 'big.json', mimeType: 'application/json', data: text });
    const all = writes();
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(appendFileMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(all.every(w => w.data.length <= STAGE_CHUNK_CHARS && w.encoding === 'utf8')).toBe(true);
    expect(all.map(w => w.data).join('')).toBe(text);
  });

  it('never splits a surrogate pair across slices', async () => {
    // An emoji straddling the slice boundary: half of it in each slice
    // would be written as two replacement characters.
    const text = 'x'.repeat(STAGE_CHUNK_CHARS - 1) + '🍝' + 'y'.repeat(10);
    await stageForNative({ fileName: 'e.json', mimeType: 'application/json', data: text });
    const pieces = writes().map(w => w.data);
    expect(pieces.join('')).toBe(text);
    for (const piece of pieces) {
      const last = piece.charCodeAt(piece.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it('slices bytes on a multiple of 3 so the base64 pieces concatenate', async () => {
    expect(STAGE_CHUNK_BYTES % 3).toBe(0);
    const bytes = new Uint8Array(STAGE_CHUNK_BYTES * 2 + 5).map((_, i) => i % 251);
    await stageForNative({ fileName: 'a.bin', mimeType: 'application/octet-stream', data: bytes });
    const decoded = Buffer.concat(writes().map(w => Buffer.from(w.data, 'base64')));
    // Buffer.equals rather than toEqual: a deep compare of 1.5 MB, element
    // by element, takes longer than the test timeout.
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.equals(Buffer.from(bytes))).toBe(true);
    expect(writes().every(w => w.encoding === undefined)).toBe(true);
  });

  it('still creates an empty file', async () => {
    await stageForNative({ fileName: 'empty.txt', mimeType: 'text/plain', data: '' });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(appendFileMock).not.toHaveBeenCalled();
  });
});

describe('slugForFilename', () => {
  it('slugs a title and falls back when nothing ASCII is left', () => {
    expect(slugForFilename('Pasta alla Norma!')).toBe('pasta-alla-norma');
    expect(slugForFilename('寿司', 'recipe')).toBe('recipe');
    expect(slugForFilename(null, 'collection')).toBe('collection');
  });
});
