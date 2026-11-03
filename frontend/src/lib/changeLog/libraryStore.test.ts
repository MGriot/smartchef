import { describe, it, expect } from 'vitest';
import { createMemoryStore } from './store';
import { formatRecoveryKey, keyIdOf, LibraryKeyError, newLibraryKey, openLibraryStore, parseRecoveryKey, type Keyring } from './libraryStore';
import { paths, plainJson, type StoreFormat } from './files';

function keyring(initial: Uint8Array | null = null, encrypt = true): Keyring & { key: Uint8Array | null } {
  const ring = {
    key: initial,
    get: async () => ring.key,
    set: async (k: Uint8Array) => { ring.key = k; },
    encryptNew: async () => encrypt,
  };
  return ring;
}

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const containsText = (bytes: Uint8Array, s: string) => new TextDecoder('latin1').decode(bytes).includes(s);

describe('encrypted library store', () => {
  it('creates an encrypted library by default, and the provider sees only ciphertext', async () => {
    const inner = createMemoryStore();
    const ring = keyring();
    const store = openLibraryStore(inner, ring);
    await store.begin!();
    expect(ring.key).toHaveLength(32);
    const format = plainJson.decode<StoreFormat>(inner.files.get(paths.format)!);
    expect(format.encryption).toEqual({ scheme: 'aes-gcm-v1', keyId: await keyIdOf(ring.key!) });

    await store.put('devices/A/head.json', text('{"device":"A","name":"Cucina di Anna"}'));
    expect(containsText(inner.files.get('devices/A/head.json')!, 'Anna')).toBe(false);
    expect(read(await store.get('devices/A/head.json'))).toBe('{"device":"A","name":"Cucina di Anna"}');
  });

  it('opens on a second device that has the key, and refuses one that does not', async () => {
    const inner = createMemoryStore();
    const a = keyring();
    const first = openLibraryStore(inner, a);
    await first.begin!();
    await first.put('devices/A/head.json', text('hello'));

    const withKey = openLibraryStore(inner, keyring(a.key));
    await withKey.begin!();
    expect(read(await withKey.get('devices/A/head.json'))).toBe('hello');

    await expect(openLibraryStore(inner, keyring()).begin!()).rejects.toMatchObject({ reason: 'missing' });
    await expect(openLibraryStore(inner, keyring(newLibraryKey())).begin!()).rejects.toBeInstanceOf(LibraryKeyError);
  });

  it('a file moved to another name no longer opens', async () => {
    const inner = createMemoryStore();
    const store = openLibraryStore(inner, keyring());
    await store.begin!();
    await store.put('devices/A/log/000000000001-000000000002.json.gz', text('segment'));
    inner.files.set('devices/B/log/000000000001-000000000002.json.gz', inner.files.get('devices/A/log/000000000001-000000000002.json.gz')!);
    await expect(store.get('devices/B/log/000000000001-000000000002.json.gz')).rejects.toThrow();
  });

  it('hides photo names, and gives them back by key', async () => {
    const inner = createMemoryStore();
    const store = openLibraryStore(inner, keyring());
    await store.begin!();
    const name = `${'a'.repeat(64)}.webp`;
    await store.put(paths.blob(name), new Uint8Array([9, 8, 7]));
    const listed = await store.list(paths.blobs);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toContain('aaaa');
    expect(listed[0]).toBe(await store.blobKey!(name));
    expect(await store.getBlobByKey!(listed[0])).toEqual({ name, data: new Uint8Array([9, 8, 7]) });
    expect(await store.get(paths.blob(name))).toEqual(new Uint8Array([9, 8, 7]));
  });

  it('stays plain when the device creating the library turned encryption off', async () => {
    const inner = createMemoryStore();
    const ring = keyring(null, false);
    const store = openLibraryStore(inner, ring);
    await store.begin!();
    expect(ring.key).toBeNull();
    expect(plainJson.decode<StoreFormat>(inner.files.get(paths.format)!).encryption).toBeUndefined();
    await store.put('devices/A/head.json', text('plain'));
    expect(read(inner.files.get('devices/A/head.json')!)).toBe('plain');
  });

  it('round-trips the recovery key, and rejects anything else', () => {
    const key = newLibraryKey();
    const code = formatRecoveryKey(key);
    expect(parseRecoveryKey(`  ${code.slice(0, 10)} ${code.slice(10)} `)).toEqual(key);
    expect(parseRecoveryKey('not a key')).toBeNull();
    expect(parseRecoveryKey(formatRecoveryKey(new Uint8Array(16)))).toBeNull();
  });
});
