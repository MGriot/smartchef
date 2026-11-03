// ════════════════════════════════════════════════════════════════════════
// SmartChef — a git server as a sync v2 store (docs/plans/2026-11-01-sync-
// v2-change-log.md §4: "GitHub / GitLab / Gitea / Forgejo, real commits")
//
// The store's files live on their own branch, `smartchef-v2`, in the same
// repository the git era used: no shared history with the old entity
// files, so reading the logs never downloads the old library, and the
// repository on GitHub shows one commit per device sync.
//
// One cycle is begin() → list/get/put → finish():
//   begin()   fetches the branch; reads are served from its tip.
//   put()     only queues the file.
//   finish()  writes the queued files as one commit on top of the tip and
//             pushes it. Rejected because another device pushed first? The
//             same files are committed again on top of the new tip and
//             pushed again. A device only ever adds files under its own
//             folder (or immutable, content-named ones), so re-applying
//             them never needs a merge: the files are replayed on the new
//             tip, never three-way merged as the old engine had to.
//
// No working tree is ever checked out: commits are built from objects
// (readTree/writeTree), which on Android saves one bridge call per file.
// The remote half (fetch/push) is injected, so the commit logic is tested
// against a real git repository without a server.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import type { SyncStore } from './store';

export const V2_BRANCH = 'smartchef-v2';
const TRACKING_REF = `refs/remotes/origin/${V2_BRANCH}`;
const LOCAL_REF = `refs/heads/${V2_BRANCH}`;
const MAX_PUSH_ATTEMPTS = 4;

export interface GitRemoteOps {
  /** Fetches the branch into TRACKING_REF; returns its oid, or null when
   *  the branch doesn't exist on the server yet. */
  fetch(): Promise<string | null>;
  /** Pushes LOCAL_REF to the branch. 'rejected' when the server holds a
   *  commit this one doesn't descend from. */
  push(): Promise<'ok' | 'rejected'>;
}

export interface GitStoreOptions {
  fs: git.PromiseFsClient | git.CallbackFsClient;
  dir: string;
  gitdir?: string;
  remote: GitRemoteOps;
  author?: { name: string; email: string };
  /** Commit message, e.g. naming the device. */
  message?: string;
}

export interface LifecycleStore extends SyncStore {
  begin(): Promise<void>;
  finish(): Promise<void>;
}

type TreeEntry = { mode: string; path: string; oid: string; type: 'blob' | 'tree' | 'commit' };

export function createGitStore(opts: GitStoreOptions): LifecycleStore {
  const { fs, dir } = opts;
  const gitdir = opts.gitdir ?? `${dir}/.git`;
  const author = opts.author ?? { name: 'SmartChef', email: 'sync@smartchef.local' };
  let tip: string | null = null;
  /** Queued writes; null queues a deletion. */
  const pending = new Map<string, Uint8Array | null>();

  async function ensureRepo(): Promise<void> {
    try {
      await git.resolveRef({ fs, dir, gitdir, ref: 'HEAD', depth: 1 });
    } catch {
      await git.init({ fs, dir, gitdir, defaultBranch: V2_BRANCH });
    }
  }

  async function treeAt(path: string): Promise<TreeEntry[] | null> {
    if (!tip) return null;
    try {
      const { tree } = await git.readTree({ fs, dir, gitdir, oid: tip, filepath: path || undefined });
      return tree as TreeEntry[];
    } catch {
      return null;
    }
  }

  /** A new root tree: `base` (a tree oid, or none) with `files` written in. */
  async function writeTreeWith(base: string | null, files: Map<string, Uint8Array | null>): Promise<string> {
    const here = new Map<string, Uint8Array | null>();
    const below = new Map<string, Map<string, Uint8Array | null>>();
    for (const [path, data] of files) {
      const slash = path.indexOf('/');
      if (slash < 0) { here.set(path, data); continue; }
      const head = path.slice(0, slash);
      if (!below.has(head)) below.set(head, new Map());
      below.get(head)!.set(path.slice(slash + 1), data);
    }
    const entries = new Map<string, TreeEntry>();
    if (base) {
      const { tree } = await git.readTree({ fs, dir, gitdir, oid: base });
      for (const e of tree as TreeEntry[]) entries.set(e.path, e);
    }
    for (const [name, data] of here) {
      if (data === null) { entries.delete(name); continue; }
      entries.set(name, { mode: '100644', path: name, type: 'blob', oid: await git.writeBlob({ fs, dir, gitdir, blob: data }) });
    }
    for (const [name, sub] of below) {
      const existing = entries.get(name);
      const oid = await writeTreeWith(existing?.type === 'tree' ? existing.oid : null, sub);
      // A folder whose last file was deleted goes too: git has no empty trees.
      const { tree } = await git.readTree({ fs, dir, gitdir, oid });
      if (tree.length === 0) entries.delete(name);
      else entries.set(name, { mode: '040000', path: name, type: 'tree', oid });
    }
    return git.writeTree({ fs, dir, gitdir, tree: [...entries.values()] });
  }

  async function commitPendingOn(parent: string | null): Promise<string> {
    const baseTree = parent ? (await git.readCommit({ fs, dir, gitdir, oid: parent })).commit.tree : null;
    const tree = await writeTreeWith(baseTree, pending);
    const now = { timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
    const oid = await git.writeCommit({
      fs, dir, gitdir,
      commit: {
        message: `${opts.message ?? 'SmartChef sync'}\n`,
        tree,
        parent: parent ? [parent] : [],
        author: { ...author, ...now },
        committer: { ...author, ...now },
      },
    });
    await git.writeRef({ fs, dir, gitdir, ref: LOCAL_REF, value: oid, force: true });
    return oid;
  }

  return {
    async begin() {
      pending.clear();
      await ensureRepo();
      tip = await opts.remote.fetch();
    },

    async list(prefix) {
      const names = new Set((await treeAt(prefix.replace(/\/+$/, '')))?.map((e) => e.path) ?? []);
      const dirPrefix = prefix.replace(/\/+$/, '') + '/';
      for (const [path, data] of pending) {
        if (!path.startsWith(dirPrefix)) continue;
        const rest = path.slice(dirPrefix.length);
        if (data === null && !rest.includes('/')) names.delete(rest);
        else if (data !== null) names.add(rest.split('/')[0]);
      }
      return [...names].sort();
    },

    async get(path) {
      const queued = pending.get(path);
      if (queued === null) return null;
      if (queued) return new Uint8Array(queued);
      if (!tip) return null;
      try {
        const { blob } = await git.readBlob({ fs, dir, gitdir, oid: tip, filepath: path });
        return blob;
      } catch {
        return null;
      }
    },

    async put(path, data) {
      pending.set(path, new Uint8Array(data));
    },

    async remove(path) {
      pending.set(path, null);
    },

    async finish() {
      if (pending.size === 0) return;
      let parent = tip;
      for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
        const oid = await commitPendingOn(parent);
        if ((await opts.remote.push()) === 'ok') {
          tip = oid;
          pending.clear();
          return;
        }
        // Another device pushed first: put the same files on top of its tip.
        parent = await opts.remote.fetch();
      }
      throw new Error('The git server kept rejecting this device\'s sync — another device may be syncing right now. It will retry on the next sync.');
    },
  };
}

export { TRACKING_REF, LOCAL_REF };
