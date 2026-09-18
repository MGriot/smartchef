import { describe, it, expect } from 'vitest';
import {
  SETUP_FILE_MAGIC,
  SETUP_FILE_VERSION,
  SetupFileError,
  decodeSetupFile,
  describeSetupPayload,
  encodeSetupFile,
  setupFileName,
  type SetupFilePayload,
} from './setupConfigFile';

// crypto.subtle is a global in Node 18+, which is what lets this module be
// tested at all in a suite with `environment: "node"` and no DOM. btoa/atob
// are globals there too, from Node 16 on.

const PASSPHRASE = 'correct horse battery';

function payload(overrides: Partial<SetupFilePayload['sync']> = {}): SetupFilePayload {
  return {
    exportedAt: '2026-09-17T21:00:00.000Z',
    exportedBy: 'Windows NT 10.0',
    sync: {
      mode: 'git-remote',
      interval: { value: 1, unit: 'hours' },
      gitRemote: {
        url: 'https://github.com/MGriot/SmartChefSync',
        username: null,
        token: 'ghp_notarealtoken',
        corsProxy: null,
      },
      ...overrides,
    },
  };
}

describe('encodeSetupFile / decodeSetupFile', () => {
  it('round-trips a git-remote configuration, token included', async () => {
    const file = await encodeSetupFile(payload(), PASSPHRASE);
    const decoded = await decodeSetupFile(file, PASSPHRASE);
    expect(decoded).toEqual(payload());
  });

  it('round-trips a folder-mode configuration with no remote', async () => {
    const folder = payload({ mode: 'folder', gitRemote: null });
    const decoded = await decodeSetupFile(await encodeSetupFile(folder, PASSPHRASE), PASSPHRASE);
    expect(decoded.sync.mode).toBe('folder');
    expect(decoded.sync.gitRemote).toBeNull();
  });

  it('never leaves the token readable in the file itself', async () => {
    const file = await encodeSetupFile(payload(), PASSPHRASE);
    expect(file).not.toContain('ghp_notarealtoken');
    expect(file).not.toContain('github.com/MGriot');
  });

  it('writes a header that identifies the format without giving anything away', async () => {
    const env = JSON.parse(await encodeSetupFile(payload(), PASSPHRASE));
    expect(env.magic).toBe(SETUP_FILE_MAGIC);
    expect(env.v).toBe(SETUP_FILE_VERSION);
    expect(env.cipher).toBe('AES-GCM');
    expect(env.kdf.iterations).toBeGreaterThanOrEqual(310_000);
  });

  it('uses a fresh salt and iv every time, so two exports never match', async () => {
    const a = JSON.parse(await encodeSetupFile(payload(), PASSPHRASE));
    const b = JSON.parse(await encodeSetupFile(payload(), PASSPHRASE));
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe('rejections', () => {
  it('rejects the wrong passphrase', async () => {
    const file = await encodeSetupFile(payload(), PASSPHRASE);
    await expect(decodeSetupFile(file, 'not the passphrase')).rejects.toMatchObject({
      name: 'SetupFileError',
      kind: 'wrong-passphrase',
    });
  });

  it('rejects a single flipped byte of ciphertext', async () => {
    const env = JSON.parse(await encodeSetupFile(payload(), PASSPHRASE));
    // Flip one base64 character — AES-GCM authenticates, so this must fail
    // rather than decrypt to garbage.
    const chars = env.ct.split('');
    chars[4] = chars[4] === 'A' ? 'B' : 'A';
    env.ct = chars.join('');
    await expect(decodeSetupFile(JSON.stringify(env), PASSPHRASE)).rejects.toBeInstanceOf(SetupFileError);
  });

  it('rejects a file whose header was edited, even with the right passphrase', async () => {
    const env = JSON.parse(await encodeSetupFile(payload(), PASSPHRASE));
    env.v = SETUP_FILE_VERSION; // unchanged
    env.magic = SETUP_FILE_MAGIC;
    // The version is bound into the AAD, so claiming a different one breaks
    // authentication rather than being silently honoured.
    const bumped = { ...env, v: SETUP_FILE_VERSION + 1 };
    await expect(decodeSetupFile(JSON.stringify(bumped), PASSPHRASE)).rejects.toMatchObject({
      kind: 'unsupported-version',
    });
  });

  it('rejects a foreign JSON file', async () => {
    await expect(decodeSetupFile('{"hello":"world"}', PASSPHRASE)).rejects.toMatchObject({
      kind: 'not-a-setup-file',
    });
  });

  it('rejects something that is not JSON at all', async () => {
    await expect(decodeSetupFile('not a file', PASSPHRASE)).rejects.toMatchObject({
      kind: 'not-a-setup-file',
    });
  });

  it('rejects a damaged envelope', async () => {
    const env = JSON.parse(await encodeSetupFile(payload(), PASSPHRASE));
    delete env.iv;
    await expect(decodeSetupFile(JSON.stringify(env), PASSPHRASE)).rejects.toMatchObject({ kind: 'corrupt' });
  });

  it('refuses to export under a too-short passphrase', async () => {
    await expect(encodeSetupFile(payload(), 'short')).rejects.toBeInstanceOf(SetupFileError);
  });

  it('rejects a payload claiming git-remote mode with no url', async () => {
    const broken = payload({ mode: 'git-remote', gitRemote: null });
    const file = await encodeSetupFile(broken, PASSPHRASE);
    await expect(decodeSetupFile(file, PASSPHRASE)).rejects.toMatchObject({ kind: 'invalid-contents' });
  });
});

describe('presentation helpers', () => {
  it('names the file by export date', () => {
    expect(setupFileName(new Date('2026-09-17T22:58:15Z'))).toBe('smartchef-setup-2026-09-17.scsetup');
  });

  it('summarises a remote without ever printing the token', () => {
    const summary = describeSetupPayload(payload());
    expect(summary).toContain('github.com/MGriot/SmartChefSync');
    expect(summary).toContain('with an access token');
    expect(summary).not.toContain('ghp_notarealtoken');
  });

  it('warns that folder mode still needs a folder chosen here', () => {
    expect(describeSetupPayload(payload({ mode: 'folder', gitRemote: null }))).toContain('sync folder');
  });
});
