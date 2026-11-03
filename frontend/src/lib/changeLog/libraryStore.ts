// ════════════════════════════════════════════════════════════════════════
// SmartChef — opening a sync v2 library, encrypted by default
// (docs/plans/2026-11-01-sync-v2-change-log.md §4, decision: "optional,
// on by default")
//
// openLibraryStore() wraps any store (folder, WebDAV, git server) so that
// the provider holds only ciphertext:
//
//   - every file except format.json is AES-GCM encrypted with the library
//     key (256-bit, random, made by the device that creates the library).
//     The file's path is the additional authenticated data, so a file
//     cannot be moved to another name — an old segment passed off as a new
//     one, another device's head as this one's — without failing to open.
//   - photos are stored under a keyed hash of their name
//     (HMAC-SHA256(key, "<sha256>.<ext>")), so a provider cannot recognise
//     a known photo by its plain SHA-256.
//   - format.json stays plain: it says the library is encrypted and which
//     key opens it (keyId, a hash of the key — never the key).
//
// The key reaches other devices in the Setup File, or typed in as the
// recovery key. A device without it is told so; nothing is guessed.
// A library created with encryption off stays plain.
// ════════════════════════════════════════════════════════════════════════

import type { SyncStore } from './store';
import { FORMAT_VERSION, paths, plainJson, type StoreFormat } from './files';

export interface Keyring {
  /** This device's copy of the library key, or null. */
  get(): Promise<Uint8Array | null>;
  set(key: Uint8Array): Promise<void>;
  /** Whether a library this device creates is encrypted. */
  encryptNew(): Promise<boolean>;
}

export class LibraryKeyError extends Error {
  constructor(message: string, readonly reason: 'missing' | 'wrong') { super(message); }
}

const SCHEME = 'aes-gcm-v1';
const MAGIC = new Uint8Array([0x53, 0x43, 0x45, 0x31]); // "SCE1"
const IV_BYTES = 12;

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
const raw = (u: Uint8Array) => Uint8Array.from(u);

export function newLibraryKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Identifies a key without revealing it: SHA-256 of a fixed label + key. */
export async function keyIdOf(key: Uint8Array): Promise<string> {
  const label = new TextEncoder().encode('smartchef-library-key-id:');
  const data = new Uint8Array(label.length + key.length);
  data.set(label);
  data.set(key, label.length);
  return hex(await crypto.subtle.digest('SHA-256', data)).slice(0, 32);
}

/** The key as the recovery code a person can copy: base64url, no padding. */
export function formatRecoveryKey(key: Uint8Array): string {
  let bin = '';
  for (const b of key) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function parseRecoveryKey(text: string): Uint8Array | null {
  const clean = text.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

async function cipherFor(key: Uint8Array) {
  const aes = await crypto.subtle.importKey('raw', raw(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const mac = await crypto.subtle.importKey('raw', raw(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const aad = (path: string) => new TextEncoder().encode(`smartchef:${path}`);
  return {
    async seal(path: string, data: Uint8Array): Promise<Uint8Array> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(path) }, aes, raw(data)));
      const out = new Uint8Array(MAGIC.length + IV_BYTES + ct.length);
      out.set(MAGIC);
      out.set(iv, MAGIC.length);
      out.set(ct, MAGIC.length + IV_BYTES);
      return out;
    },
    async open(path: string, data: Uint8Array): Promise<Uint8Array> {
      if (data.length < MAGIC.length + IV_BYTES || !MAGIC.every((b, i) => data[i] === b)) throw new Error(`${path} is not an encrypted SmartChef file`);
      const iv = data.slice(MAGIC.length, MAGIC.length + IV_BYTES);
      const ct = data.slice(MAGIC.length + IV_BYTES);
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(path) }, aes, ct));
    },
    async blobKey(name: string): Promise<string> {
      return `${hex(await crypto.subtle.sign('HMAC', mac, new TextEncoder().encode(name)))}.bin`;
    },
  };
}

type Cipher = Awaited<ReturnType<typeof cipherFor>>;

/** A blob as the encrypted store keeps it: its real name travels inside. */
interface SealedBlob { name: string; data: string }

/** The library behind `inner`, created when the store is empty. begin()
 *  reads format.json (after the inner store's own begin, e.g. a git fetch)
 *  and decides plain or encrypted; every call after that goes through. */
export function openLibraryStore(inner: SyncStore, keyring: Keyring): SyncStore & { format(): StoreFormat | null } {
  let cipher: Cipher | null = null;
  let format: StoreFormat | null = null;

  const isBlob = (path: string) => path.startsWith(`${paths.blobs}/`);

  async function getBlobByKey(key: string): Promise<{ name: string; data: Uint8Array } | null> {
    const bytes = await inner.get(paths.blob(key));
    if (!bytes) return null;
    if (!cipher) return { name: key, data: bytes };
    const sealed = JSON.parse(new TextDecoder().decode(await cipher.open(paths.blob(key), bytes))) as SealedBlob;
    // The name inside must be the one the key was made from.
    if ((await cipher.blobKey(sealed.name)) !== key) return null;
    return { name: sealed.name, data: Uint8Array.from(atob(sealed.data), (c) => c.charCodeAt(0)) };
  }

  return {
    format: () => format,

    async begin() {
      await inner.begin?.();
      const bytes = await inner.get(paths.format);
      if (bytes) {
        format = plainJson.decode<StoreFormat>(bytes);
      } else {
        const encrypt = await keyring.encryptNew();
        let key = encrypt ? await keyring.get() : null;
        if (encrypt && !key) {
          key = newLibraryKey();
          await keyring.set(key);
        }
        format = {
          format: 'smartchef-sync', version: FORMAT_VERSION, libraryId: crypto.randomUUID(), createdAt: new Date().toISOString(),
          ...(key ? { encryption: { scheme: SCHEME, keyId: await keyIdOf(key) } } : {}),
        };
        await inner.put(paths.format, plainJson.encode(format));
      }
      cipher = null;
      if (format.encryption) {
        const key = await keyring.get();
        if (!key) throw new LibraryKeyError('This library is encrypted. Import the Setup File from one of its devices, or enter its recovery key in Account → Folder Sync.', 'missing');
        if ((await keyIdOf(key)) !== format.encryption.keyId) {
          throw new LibraryKeyError('The recovery key on this device does not open this library. Enter the right one in Account → Folder Sync.', 'wrong');
        }
        cipher = await cipherFor(key);
      }
    },

    finish: () => inner.finish?.() ?? Promise.resolve(),

    async list(prefix) {
      return inner.list(prefix);
    },

    async get(path) {
      if (cipher && isBlob(path)) {
        const blob = await getBlobByKey(await cipher.blobKey(path.slice(paths.blobs.length + 1)));
        return blob?.data ?? null;
      }
      const bytes = await inner.get(path);
      if (!bytes || !cipher || path === paths.format) return bytes;
      return cipher.open(path, bytes);
    },

    async put(path, data) {
      if (!cipher || path === paths.format) return inner.put(path, data);
      if (!isBlob(path)) return inner.put(path, await cipher.seal(path, data));
      const name = path.slice(paths.blobs.length + 1);
      let bin = '';
      for (const b of data) bin += String.fromCharCode(b);
      const sealed: SealedBlob = { name, data: btoa(bin) };
      const at = paths.blob(await cipher.blobKey(name));
      return inner.put(at, await cipher.seal(at, new TextEncoder().encode(JSON.stringify(sealed))));
    },

    async blobKey(name) {
      return cipher ? cipher.blobKey(name) : name;
    },

    getBlobByKey,

    ...(inner.remove ? { remove: (path: string) => inner.remove!(path) } : {}),
  };
}
