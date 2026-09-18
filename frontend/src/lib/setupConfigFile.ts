// ════════════════════════════════════════════════════════════════════════
// SmartChef — Setup File
//
// A Setup File is one encrypted document carrying this device's Folder Sync
// configuration to another device: the Sync Mode, the auto-sync interval,
// and (in Git Remote mode) the repository URL, username and access token.
// Onboarding a second device otherwise means re-typing a URL and pasting a
// token on a phone keyboard, which is where people give up.
//
// WHAT IS DELIBERATELY NOT IN IT: the Sync Folder itself. In Folder mode
// that is a native handle — an absolute path on Windows, a Storage Access
// Framework tree URI on Android (lib/syncFolderPicker.ts) — and neither
// means anything on the other device. A Folder-mode device still picks its
// own folder after importing; the UI says so rather than appearing to carry
// something it can't.
//
// ── On "only our app can decrypt it" ────────────────────────────────────
// The file is AES-256-GCM, with the key derived by PBKDF2 from a passphrase
// the user picks, inside a SmartChef-specific container. Two distinct
// properties, and they are worth not conflating:
//
//   - Only SmartChef can *parse* it. The magic string, the version and the
//     KDF context below are ours; nothing else knows the shape.
//   - Only the passphrase-holder can *read* it. This is the part that
//     actually matters, because the payload contains a git token with write
//     access to the user's library.
//
// The alternative — a key compiled into the app, so a file "just opens" —
// was rejected: that key ships inside every APK and every Windows installer,
// so anyone who unpacks one can read every Setup File ever exported. It
// would satisfy the letter of "only our application can decrypt it" while
// giving a leaked file no protection at all. See ADR 0005.
//
// crypto.subtle is already load-bearing in this app (lib/localImages.ts
// hashes every image, lib/sync/gitObjectTransport.ts hashes every git
// object), so it is known-good on Chromium 114 in the Electron build and on
// Android's WebView — and it exists in Node, which is what makes this
// module testable in a suite that has no DOM.
// ════════════════════════════════════════════════════════════════════════

import type { SyncInterval, SyncIntervalUnit, SyncMode } from './sync/syncSettings';

/** Identifies the format. Also fed to AES-GCM as additional authenticated
 *  data, so editing the header of a file invalidates it outright instead of
 *  decrypting into something subtly wrong. */
export const SETUP_FILE_MAGIC = 'smartchef.setup';
export const SETUP_FILE_VERSION = 1;
export const SETUP_FILE_EXTENSION = '.scsetup';

/** Mixed into the derived key, so the same passphrase run through a plain
 *  PBKDF2 implementation elsewhere does not produce this file's key. */
const KDF_CONTEXT = 'smartchef-setup-file-v1';

/** OWASP's floor for PBKDF2-HMAC-SHA256. A one-off cost on export and on
 *  import — a few hundred milliseconds even on a slow phone — and the only
 *  thing standing between a leaked file and a working git token. */
const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** Shortest passphrase accepted. Deliberately a length floor and nothing
 *  else: composition rules push people towards `Password1!`, and the real
 *  work here is done by the iteration count above. */
export const MIN_PASSPHRASE_LENGTH = 8;

export interface SetupFilePayload {
  /** ISO timestamp, shown on import so a stale file is recognisable. */
  exportedAt: string;
  /** The exporting device's name, for the same reason. */
  exportedBy?: string;
  sync: {
    mode: SyncMode;
    interval: SyncInterval;
    gitRemote: {
      url: string;
      username: string | null;
      token: string | null;
      corsProxy: string | null;
    } | null;
  };
}

interface SetupFileEnvelope {
  magic: string;
  v: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: 'AES-GCM';
  iv: string;
  ct: string;
}

/** Thrown for every failure mode a user can actually hit, so the UI can say
 *  something true instead of "decryption failed". */
export class SetupFileError extends Error {
  constructor(
    readonly kind: 'not-a-setup-file' | 'unsupported-version' | 'wrong-passphrase' | 'corrupt' | 'invalid-contents',
    message: string,
  ) {
    super(message);
    this.name = 'SetupFileError';
  }
}

// ── base64 without Buffer ───────────────────────────────────────────────
// btoa/atob exist in every browser this ships to and in Node 16+, unlike
// Buffer, which would drag a polyfill into the bundle.

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on
  // anything large, and a payload with a long token is not tiny.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** TypeScript's DOM lib types BufferSource as an ArrayBuffer-backed view,
 *  while TextEncoder and `new Uint8Array` are typed over ArrayBufferLike
 *  (which also admits SharedArrayBuffer). Every value handed to crypto.subtle
 *  below is a plain Uint8Array over a plain ArrayBuffer, so this is a
 *  types-only gap — narrowed in one place rather than at each call site. */
function buf(view: Uint8Array): BufferSource {
  return view as unknown as BufferSource;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    buf(utf8(`${KDF_CONTEXT}\u0000${passphrase}`)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: buf(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The bytes bound into the ciphertext's authentication tag: the header this
 *  file claims to have. A file whose magic or version was edited fails to
 *  authenticate rather than being read under the wrong rules. */
function additionalData(version: number): Uint8Array {
  return utf8(`${SETUP_FILE_MAGIC}/${version}`);
}

/** Encrypts `payload` into the text written to disk. */
export async function encodeSetupFile(payload: SetupFilePayload, passphrase: string): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new SetupFileError('wrong-passphrase', `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: buf(iv),
      additionalData: buf(additionalData(SETUP_FILE_VERSION)),
    },
    key,
    buf(utf8(JSON.stringify(payload))),
  );

  const envelope: SetupFileEnvelope = {
    magic: SETUP_FILE_MAGIC,
    v: SETUP_FILE_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    cipher: 'AES-GCM',
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  };
  // Pretty-printed so the header is legible in a text editor: someone who
  // finds this file years later should be able to tell what it belongs to
  // without it giving anything away.
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function parseEnvelope(text: string): SetupFileEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SetupFileError('not-a-setup-file', 'That file is not a SmartChef setup file.');
  }
  const env = parsed as Partial<SetupFileEnvelope>;
  if (!env || typeof env !== 'object' || env.magic !== SETUP_FILE_MAGIC) {
    throw new SetupFileError('not-a-setup-file', 'That file is not a SmartChef setup file.');
  }
  if (env.v !== SETUP_FILE_VERSION) {
    throw new SetupFileError(
      'unsupported-version',
      'That setup file was written by a newer version of SmartChef. Update the app and try again.',
    );
  }
  if (
    env.cipher !== 'AES-GCM' ||
    typeof env.iv !== 'string' ||
    typeof env.ct !== 'string' ||
    !env.kdf ||
    env.kdf.name !== 'PBKDF2' ||
    typeof env.kdf.salt !== 'string' ||
    typeof env.kdf.iterations !== 'number'
  ) {
    throw new SetupFileError('corrupt', 'That setup file is damaged and cannot be read.');
  }
  return env as SetupFileEnvelope;
}

function assertPayload(value: unknown): SetupFilePayload {
  const payload = value as Partial<SetupFilePayload>;
  const sync = payload?.sync;
  if (!sync || (sync.mode !== 'folder' && sync.mode !== 'git-remote')) {
    throw new SetupFileError('invalid-contents', 'That setup file does not contain sync settings.');
  }
  // A file whose git-remote block is missing a URL would import as "Git
  // Remote mode, configured against nothing", which fails later and far
  // from here. Reject it while there is still context to explain it.
  if (sync.mode === 'git-remote' && !sync.gitRemote?.url) {
    throw new SetupFileError('invalid-contents', 'That setup file is set to Git Remote mode but has no repository URL.');
  }
  return payload as SetupFilePayload;
}

/** Decrypts a Setup File. Throws `SetupFileError` with a `kind` the UI can
 *  act on — notably, a wrong passphrase and a tampered file are genuinely
 *  indistinguishable to AES-GCM, so both surface as 'wrong-passphrase'
 *  rather than pretending to tell them apart. */
export async function decodeSetupFile(text: string, passphrase: string): Promise<SetupFilePayload> {
  const env = parseEnvelope(text);
  const key = await deriveKey(passphrase, fromBase64(env.kdf.salt), env.kdf.iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: buf(fromBase64(env.iv)),
        additionalData: buf(additionalData(env.v)),
      },
      key,
      buf(fromBase64(env.ct)),
    );
  } catch {
    throw new SetupFileError('wrong-passphrase', 'Wrong passphrase, or the file has been altered.');
  }
  try {
    return assertPayload(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch (err) {
    if (err instanceof SetupFileError) throw err;
    throw new SetupFileError('corrupt', 'That setup file is damaged and cannot be read.');
  }
}

/** `smartchef-setup-2026-09-17.scsetup` — dated, because the whole point is
 *  carrying one of these between devices and knowing which is current. */
export function setupFileName(now: Date = new Date()): string {
  return `smartchef-setup-${now.toISOString().slice(0, 10)}${SETUP_FILE_EXTENSION}`;
}

/** A one-line summary of what an imported file will change, for the
 *  confirmation step. Never includes the token itself. */
export function describeSetupPayload(payload: SetupFilePayload): string {
  const { mode, interval, gitRemote } = payload.sync;
  const every = `every ${interval.value} ${interval.unit as SyncIntervalUnit}`;
  if (mode === 'git-remote' && gitRemote) {
    const token = gitRemote.token ? 'with an access token' : 'with no access token';
    return `Git Remote mode — ${gitRemote.url} (${token}), syncing ${every}.`;
  }
  return `Folder mode, syncing ${every}. You will still need to choose this device's own sync folder.`;
}
