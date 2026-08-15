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
