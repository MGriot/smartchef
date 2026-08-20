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

function isUtf8Request(options: unknown): boolean {
  if (typeof options === 'string') return /utf-?8/i.test(options);
  if (options && typeof options === 'object' && 'encoding' in options) {
    return /utf-?8/i.test(String((options as { encoding?: string }).encoding ?? ''));
  }
  return false;
}

export interface FakeLocalFs {
  promises: {
    // Matches gitfs.ts's real readFile(path, options?) contract — callers
    // like reconcileEntity() in gitSync.ts pass 'utf8' expecting a string
    // back, not raw bytes; getting that wrong here means JSON.parse()
    // silently fails on a stringified byte array and every reconcile
    // looks like "corrupt file, skip" with no visible error.
    readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
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
    async readFile(path, options) {
      const bytes = files.get(normalize(path));
      if (!bytes) throw new Error(`ENOENT: no such file, '${path}'`);
      return isUtf8Request(options) ? new TextDecoder().decode(bytes) : bytes;
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

// ── Fake remote transport (gitObjectTransport.ts's RemoteTransport shape)
// — a plain content-addressed-agnostic key/value store, deliberately
// simpler than the SAF tree fake above (no pickTree/isDirectory bookkeeping
// needed): exists/readFile/writeFile/listDir over a flat Map, same
// normalize-path convention as the fakes above so paths compare identically
// across all three fakes in a test. Platform-agnostic by design — the same
// shape an Electron-direct-fs transport or a future SafMirror-backed one
// would both implement. ───────────────────────────────────────────────────

export interface FakeRemoteTransport {
  exists(relativePath: string): Promise<boolean>;
  readFile(relativePath: string): Promise<Uint8Array>;
  writeFile(relativePath: string, data: Uint8Array): Promise<void>;
  listDir(relativePath: string): Promise<string[]>;
  files: Map<string, Uint8Array>;
}

export function createFakeRemoteTransport(): FakeRemoteTransport {
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

  return {
    files,
    async exists(relativePath) {
      return files.has(normalize(relativePath));
    },
    async readFile(relativePath) {
      const bytes = files.get(normalize(relativePath));
      if (!bytes) throw new Error(`ENOENT: no such file, '${relativePath}'`);
      return bytes;
    },
    async writeFile(relativePath, data) {
      files.set(normalize(relativePath), data);
    },
    async listDir(relativePath) {
      // Missing directory -> empty list, not an error: a fresh remote with
      // no history yet is the normal case, not a failure.
      return childNames(relativePath);
    },
  };
}

export function putRemoteText(remote: FakeRemoteTransport, path: string, text: string): void {
  remote.files.set(normalize(path), new TextEncoder().encode(text));
}

export function getRemoteText(remote: FakeRemoteTransport, path: string): string | undefined {
  const bytes = remote.files.get(normalize(path));
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

// ── Fake db/local — just enough of gitSync.ts's actual query()/queryOne()
// surface to support the two-device convergence integration tests (10):
// the recipes/ingredients upsert (INSERT ... ON CONFLICT(id) DO UPDATE),
// the "SELECT updated_at ... WHERE id = $1" LWW check, and the recipe
// child-table (recipe_ingredients/recipe_steps/recipe_tools) DELETE+INSERT
// calls reconcileRecipeChildren() always issues — those are accepted as
// no-ops rather than modeled, since convergence at the recipe-row level is
// what these tests need, not full relational fidelity. Routes by matching
// against the exact, small, fixed set of SQL templates gitSync.ts actually
// generates (not a real SQL parser) — throws on anything unrecognized so
// a future change to those templates fails loudly here instead of
// silently no-op'ing. ─────────────────────────────────────────────────────

export interface FakeDb {
  query(sql: string, values?: unknown[]): Promise<unknown[]>;
  queryOne<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T | undefined>;
  tables: {
    recipes: Map<string, Record<string, unknown>>;
    ingredients: Map<string, Record<string, unknown>>;
  };
}

const CHILD_TABLE_NOOP = /^(DELETE FROM recipe_(ingredients|steps|tools)|INSERT INTO recipe_(ingredients|steps|tools))\b/;

export function createFakeDb(): FakeDb {
  const recipes = new Map<string, Record<string, unknown>>();
  const ingredients = new Map<string, Record<string, unknown>>();

  function tableFor(name: string): Map<string, Record<string, unknown>> | null {
    if (name === 'recipes') return recipes;
    if (name === 'ingredients') return ingredients;
    return null;
  }

  async function query(sql: string, values: unknown[] = []): Promise<unknown[]> {
    const trimmed = sql.trim();

    if (trimmed.startsWith('INSERT INTO recipes') || trimmed.startsWith('INSERT INTO ingredients')) {
      const match = trimmed.match(/INSERT INTO (\w+) \(([^)]+)\)/);
      if (!match) throw new Error(`fake db: could not parse upsert: ${sql}`);
      const table = tableFor(match[1])!;
      const columns = match[2].split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      table.set(String(row.id), row);
      return [];
    }

    if (CHILD_TABLE_NOOP.test(trimmed)) return [];

    throw new Error(`fake db: unrecognized query — ${sql}`);
  }

  async function queryOne<T>(sql: string, values: unknown[] = []): Promise<T | undefined> {
    const trimmed = sql.trim();
    const match = trimmed.match(/^SELECT updated_at FROM (\w+) WHERE id = \$1$/);
    if (match) {
      const table = tableFor(match[1]);
      if (!table) throw new Error(`fake db: unknown table '${match[1]}'`);
      const row = table.get(String(values[0]));
      return row ? ({ updated_at: row.updated_at } as unknown as T) : undefined;
    }
    throw new Error(`fake db: unrecognized queryOne — ${sql}`);
  }

  return { query, queryOne, tables: { recipes, ingredients } };
}
