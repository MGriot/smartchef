// ════════════════════════════════════════════════════════════════════════
// SmartChef — First-run profile probe
//
// "Who is using this device?" is the only question first-run setup actually
// needs answered before it can let someone in, and it needs six small JSON
// files to answer it. It used to wait for a great deal more than that: the
// setup screen ran a complete syncNow() — full-history download, then a
// merge that writes every recipe, ingredient, tool, tag and technique into
// SQLite and materializes every image — and only then listed the profiles.
// On Android that was long enough to look like a hang, and (before the
// streaming fix in GitHttpPlugin.java) long enough to be killed outright.
//
// So this fetches the minimum that can answer it, and gets out of the way:
//
//   1. Clone ONLY the tip commit, with no working tree (shallowCloneTip).
//      13 MB → 2.3 MB on a real library; nothing is written to disk but
//      git objects.
//   2. Read profiles/*.json straight out of that commit and import just
//      those rows. getActiveProfile() reads the SQLite row rather than
//      just the Preferences pointer, so the picked profile does have to
//      exist locally before the app will accept it.
//   3. Throw the probe clone away. The real Hidden Clone is untouched and
//      syncs normally in the background once the user is in.
//
// ── Why this does NOT just merge profiles first ────────────────────────
// The obvious version — run the normal merge but only for the `profiles`
// entry in mergeBridge.ts's ENTITY_DIRS, then do the rest later — silently
// destroys data, and it is worth writing down so nobody "simplifies" this
// back into it. gitSync.ts's applyMergeIfNeeded() COMMITS after a merge.
// On the next cycle findMergeBase() then resolves to the remote oid
// itself, so mergeEntity() compares remote against a base that already
// equals it, concludes nothing changed, and every entity type skipped by
// the first pass is never imported — on that sync or any future one. No
// error, no conflict, just a permanently empty library.
//
// Reading blobs out of a throwaway clone touches none of that machinery:
// no merge, no commit, no ref moved in the Hidden Clone. The full sync
// that follows is the ordinary one, and re-applies these same profiles
// harmlessly (createEntity() below is ON CONFLICT DO NOTHING, and the
// merge treats an unchanged row as a no-op).
//
// Git Remote mode only. Folder mode reaches its Sync Folder over local
// I/O rather than a network, has no shallow-fetch equivalent through
// gitObjectTransport.ts's object copying, and is not where this hurts —
// so it keeps the previous full-sync path, and probeFirstRunProfiles()
// reports that by returning `supported: false`.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import { gitfs } from '../gitfs';
import { getHiddenCloneDir } from './hiddenClone';
import { getSyncMode, getGitRemoteConfig } from './syncSettings';
import { shallowCloneTip } from './gitRemoteTransport';

export interface ProbedProfile {
  id: string;
  name: string;
  avatarUrl?: string;
  role?: string;
}

export interface FirstRunProbeResult {
  /** false when this sync mode has no fast path and the caller should fall
   *  back to a full sync — not a failure. */
  supported: boolean;
  profiles: ProbedProfile[];
}

/** Sibling of the Hidden Clone rather than a child of it: everything under
 *  the Hidden Clone's own directory is either a committed entity directory
 *  or `.git`, and a stray sibling directory there would be picked up by the
 *  statusMatrix/add calls that walk it. */
async function probeCloneDirs(): Promise<{ dir: string; gitdir: string }> {
  const dir = `${await getHiddenCloneDir()}-probe`;
  return { dir, gitdir: `${dir}/.git` };
}

/** gitfs's rmdir() is not recursive on either platform, so this walks.
 *  Always best-effort: a probe clone left behind costs disk, while
 *  throwing here would fail a setup that has otherwise just succeeded. */
async function removeRecursively(path: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await gitfs.promises.readdir(path);
  } catch {
    return; // not a directory, or already gone
  }
  for (const entry of entries) {
    const child = `${path}/${entry}`;
    const stat = await gitfs.promises.stat(child).catch(() => null);
    if (stat?.isDirectory()) await removeRecursively(child);
    else await gitfs.promises.unlink(child).catch(() => {});
  }
  await gitfs.promises.rmdir(path).catch(() => {});
}

function toProbedProfile(id: string, json: Record<string, unknown>): ProbedProfile | null {
  const name = typeof json.name === 'string' ? json.name : null;
  if (!name) return null; // a record with no name can't be shown in a picker
  // Deleted elsewhere: the tombstone travels as a field like any other
  // change (see CONTEXT.md's Deletion Marker), so it has to be honoured
  // here too or the picker offers people who were removed.
  if (json.deleted_at) return null;
  return {
    id,
    name,
    avatarUrl: typeof json.avatar_url === 'string' ? json.avatar_url : undefined,
    role: typeof json.role === 'string' ? json.role : undefined,
  };
}

/** Reads the library's profiles without merging anything. See the module
 *  header for why it clones rather than syncing, and why it must not
 *  reuse the merge path. */
export async function probeFirstRunProfiles(
  onProgress?: (loaded: number, total: number) => void
): Promise<FirstRunProbeResult> {
  if ((await getSyncMode()) !== 'git-remote') return { supported: false, profiles: [] };
  const config = await getGitRemoteConfig();
  if (!config?.url) return { supported: false, profiles: [] };

  const { dir, gitdir } = await probeCloneDirs();
  // A probe from an interrupted previous attempt would make clone() fail on
  // an already-populated directory.
  await removeRecursively(dir);

  try {
    const oid = await shallowCloneTip(dir, gitdir, config, onProgress);
    if (!oid) return { supported: true, profiles: [] }; // reachable, but nothing synced into it yet

    const files = await git.listFiles({ fs: gitfs, dir, gitdir, ref: oid });
    const ids = files
      .filter((f) => f.startsWith('profiles/') && f.endsWith('.json'))
      .map((f) => f.slice('profiles/'.length, -'.json'.length));

    const profiles: ProbedProfile[] = [];
    for (const id of ids) {
      try {
        const { blob } = await git.readBlob({ fs: gitfs, dir, gitdir, oid, filepath: `profiles/${id}.json` });
        const parsed = toProbedProfile(id, JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown>);
        if (parsed) profiles.push(parsed);
      } catch (err) {
        // One unreadable profile must not cost the user the others — the
        // full sync that follows will report it properly through
        // mergeBridge.ts's failedEntities.
        console.error(`SmartChef: could not read profile ${id} during first-run probe:`, err);
      }
    }
    profiles.sort((a, b) => a.name.localeCompare(b.name));
    return { supported: true, profiles };
  } finally {
    await removeRecursively(dir);
  }
}

/** Writes the probed profiles into Local Storage so the picked one exists
 *  as a real row by the time the app asks for it.
 *
 *  Only profiles — deliberately. Everything else arrives with the ordinary
 *  background sync, which is the entire point of the split. */
export async function importProbedProfiles(profiles: ProbedProfile[]): Promise<void> {
  if (profiles.length === 0) return;
  const { initLocalSchema } = await import('../../db/local');
  await initLocalSchema();
  const { createEntity } = await import('../../services/conflicts.local');
  for (const p of profiles) {
    try {
      await createEntity('profile', p.id, {
        name: p.name,
        avatar_url: p.avatarUrl ?? null,
        role: p.role ?? 'user',
      });
    } catch (err) {
      console.error(`SmartChef: could not import profile ${p.id}:`, err);
    }
  }
}
