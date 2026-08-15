// ════════════════════════════════════════════════════════════════════════
// SmartChef — Shared in-memory fakes for androidMirror.ts tests
// A fake SAF tree (backed by a flat Map, directories derived from key
// prefixes — the same shape a real tree exposes) plus small helpers for
// seeding/reading its content as UTF-8 text. Reused across the pull tests
// (6a), push tests (7a), and the two-device convergence integration tests
// (10) per the implementation plan — building this once here rather than
// duplicating an in-memory tree per test file.
// ════════════════════════════════════════════════════════════════════════

import type { SafEntry, SafMirrorPlugin } from '../../safMirrorBridge';

function normalize(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64Decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export interface FakeSafTree {
  plugin: SafMirrorPlugin;
  uri: string;
  /** Direct access for test setup/assertions — keys are normalized
   *  (no leading/trailing slash), values are raw bytes. */
  files: Map<string, Uint8Array>;
}

export function createFakeSafTree(uri = 'fake://tree'): FakeSafTree {
  const files = new Map<string, Uint8Array>();

  function childrenOf(dirPath: string): SafEntry[] {
    const prefix = dirPath ? `${dirPath}/` : '';
    const seen = new Map<string, boolean>(); // name -> isDirectory
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash === -1) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen.entries()].map(([name, isDirectory]) => ({
      name,
      isDirectory,
      size: isDirectory ? 0 : (files.get(`${prefix}${name}`)?.length ?? 0),
    }));
  }

  const plugin: SafMirrorPlugin = {
    async pickTree() {
      return { uri, displayName: 'Fake Tree' };
    },
    async hasPersistedTree() {
      return { uri, displayName: 'Fake Tree' };
    },
    async list({ path }) {
      return { entries: childrenOf(normalize(path)) };
    },
    async readFile({ path }) {
      const bytes = files.get(normalize(path));
      if (!bytes) throw new Error(`ENOENT: no such file, '${path}'`);
      return { data: base64Encode(bytes) };
    },
    async writeFile({ path, data }) {
      files.set(normalize(path), base64Decode(data));
    },
    async deleteFile({ path }) {
      files.delete(normalize(path));
    },
  };

  return { plugin, uri, files };
}

export function putText(tree: FakeSafTree, path: string, text: string): void {
  tree.files.set(normalize(path), new TextEncoder().encode(text));
}

export function getText(tree: FakeSafTree, path: string): string | undefined {
  const bytes = tree.files.get(normalize(path));
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

export function putBytes(tree: FakeSafTree, path: string, bytes: Uint8Array): void {
  tree.files.set(normalize(path), bytes);
}

// ── Fake local fs (the private working copy androidMirror.ts reads/writes
// via gitfs.promises) — same flat-Map-with-derived-directories shape as
// the fake SAF tree above, so push/pull tests can seed and inspect
// "what's on this device" the same way they seed "what's on the target." ─

export interface FakeLocalFs {
  promises: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<Record<string, never>>;
    lstat(path: string): Promise<Record<string, never>>;
    rename(oldPath: string, newPath: string): Promise<void>;
  };
  files: Map<string, Uint8Array>;
}

export function createFakeLocalFs(): FakeLocalFs {
  const files = new Map<string, Uint8Array>();

  function childNames(dirPath: string): string[] {
    const prefix = dirPath ? `${normalize(dirPath)}/` : '';
    const seen = new Set<string>();
    for (const key of files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      seen.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [...seen];
  }

  const promises: FakeLocalFs['promises'] = {
    async readFile(path) {
      const bytes = files.get(normalize(path));
      if (!bytes) throw new Error(`ENOENT: no such file, '${path}'`);
      return bytes;
    },
    async writeFile(path, data) {
      files.set(normalize(path), typeof data === 'string' ? new TextEncoder().encode(data) : data);
    },
    async unlink(path) {
      files.delete(normalize(path));
    },
    async readdir(path) {
      const names = childNames(path);
      // Matches real fs semantics closely enough for these tests: a
      // directory with no children at all (nothing ever written under it)
      // throws, same as a genuinely missing directory would. An
      // existing-but-empty directory isn't representable in this flat-map
      // model — not a gap that matters here, since every caller in
      // androidMirror.ts treats "throws" and "empty array" identically
      // (nothing to do).
      if (!names.length) throw new Error(`ENOENT: no such directory, '${path}'`);
      return names;
    },
    async mkdir() {},
    async rmdir() {},
    async stat(path) {
      if (!files.has(normalize(path))) throw new Error(`ENOENT: no such file, '${path}'`);
      return {};
    },
    async lstat(path) {
      return promises.stat(path);
    },
    async rename(oldPath, newPath) {
      const bytes = files.get(normalize(oldPath));
      if (!bytes) throw new Error(`ENOENT: no such file, '${oldPath}'`);
      files.delete(normalize(oldPath));
      files.set(normalize(newPath), bytes);
    },
  };

  return { promises, files };
}

export function putLocalText(fs: FakeLocalFs, path: string, text: string): void {
  fs.files.set(normalize(path), new TextEncoder().encode(text));
}

export function getLocalText(fs: FakeLocalFs, path: string): string | undefined {
  const bytes = fs.files.get(normalize(path));
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}
