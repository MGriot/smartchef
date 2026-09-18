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
// back into it. gitSync.ts's applyMergeIfNeeded() commits a two-parent
// merge commit after a merge (ADR 0006), making the remote an ancestor —
// the next cycle sees it as already merged (isDescendent) and skips it
// outright. Every entity type skipped by the first pass would never be
// imported — on that sync or any future one. No error, no conflict, just a
// permanently empty library.
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
import { gitCache, resetGitCache } from './gitCache';
import { getHiddenCloneDir } from './hiddenClone';
import { getSyncMode, getGitRemoteConfig, setGitRemoteAccessProblem } from './syncSettings';
import { shallowCloneTip } from './gitRemoteTransport';
import { listDirectoryFiles } from './hostContentsApi';
import { observeDownloadProgress } from '../gitHttpBridge';

export interface ProbedProfile {
  id: string;
  name: string;
  avatarUrl?: string;
  role?: string;
  /** Only used to decide who the admin is when nobody is marked as one —
   *  see applyAdminFallback(). Not shown anywhere. */
  createdAt?: string;
}

/** What the probe is doing right now, so the setup screen can say so.
 *  A spinner with no phase and no numbers is indistinguishable from a
 *  wedged app — which is exactly how this was reported. */
export type ProbePhase =
  | { kind: 'connecting' }
  | { kind: 'downloading'; loaded: number; total: number }
  /** The bytes are in; isomorphic-git is hashing every object in the pack.
   *  Its own onProgress cannot report this, and on a phone it is usually
   *  the longest part — so it gets a name rather than hiding inside
   *  whatever phase happened to be showing. Only the clone path reaches it. */
  | { kind: 'preparing' }
  | { kind: 'reading' };

/** Bounds the whole probe, not one HTTP request (nativeHttpClient.ts has
 *  its own 180s per-request deadline). Without this, anything that stalls
 *  short of a socket timeout — a stuck read, a pathologically slow link —
 *  leaves the setup screen spinning with no way out but force-quitting.
 *  Generous, because it should only ever fire on something genuinely
 *  broken: the measured happy path is a couple of seconds. */
const PROBE_TIMEOUT_MS = 120_000;

export interface FirstRunProbeResult {
  /** false when this sync mode has no fast path and the caller should fall
   *  back to a full sync — not a failure. */
  supported: boolean;
  profiles: ProbedProfile[];
  /** The configured token was refused but the library was still readable
   *  without it. Onboarding can continue; uploads from this device cannot. */
  tokenRejected?: boolean;
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
    createdAt: typeof json.created_at === 'string' ? json.created_at : undefined,
  };
}

/** Marks the earliest-created profile as admin when none of them says it is.
 *
 *  Not a guess — it is the same rule the rest of the app already settles on
 *  from two directions: profiles.local.ts makes the first profile ever
 *  created an admin, and initLocalSchema() promotes the earliest surviving
 *  profile whenever a library ends up with no admin at all.
 *
 *  It matters here because `role` is a later addition, so a profile whose
 *  entity file was written before it exists carries no role at all — and
 *  this library's one live profile is exactly that. Without this, the
 *  picker would show the owner of the library as an ordinary user, and
 *  importProbedProfiles() would write them in as one; initLocalSchema()
 *  would then quietly promote them on the NEXT launch, so the admin-only
 *  screens were missing exactly once, on the run where someone is most
 *  likely to go looking for them. */
function applyAdminFallback(profiles: ProbedProfile[]): ProbedProfile[] {
  if (profiles.length === 0) return profiles;
  if (profiles.some((p) => p.role === 'admin')) return profiles;
  // Undated records sort last: a real timestamp is better evidence of
  // "first" than the absence of one.
  const earliest = [...profiles].sort((a, b) =>
    (a.createdAt ?? '￿').localeCompare(b.createdAt ?? '￿'))[0];
  return profiles.map((p) => (p.id === earliest.id ? { ...p, role: 'admin' } : p));
}

/** Reads the library's profiles without merging anything. See the module
 *  header for why it clones rather than syncing, and why it must not
 *  reuse the merge path. */
export async function probeFirstRunProfiles(
  onPhase?: (phase: ProbePhase) => void
): Promise<FirstRunProbeResult> {
  if ((await getSyncMode()) !== 'git-remote') return { supported: false, profiles: [] };
  const config = await getGitRemoteConfig();
  if (!config?.url) return { supported: false, profiles: [] };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${PROBE_TIMEOUT_MS / 1000}s while reading the library's profiles.`)),
      PROBE_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([probeInner(config, onPhase), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function probeInner(
  config: NonNullable<Awaited<ReturnType<typeof getGitRemoteConfig>>>,
  onPhase?: (phase: ProbePhase) => void
): Promise<FirstRunProbeResult> {

  // ── Fast path: ask the host for the five files ──────────────────────
  // A depth-1 clone is the cheapest thing GIT will do; it is not the
  // cheapest thing available. GitHub and GitLab will simply hand over a
  // directory — 5.6 KB and no packfile against the real library, versus
  // 2.1 MB and indexing ~500 objects in JS. Tried first, and never fatal:
  // an unrecognised host returns null and a failure falls through to the
  // clone below, which is still correct, just slower.
  onPhase?.({ kind: 'connecting' });
  let tokenRejected = false;
  try {
    const startedAt = Date.now();
    const listing = await listDirectoryFiles(config, 'profiles');
    if (listing) {
      const { files } = listing;
      tokenRejected = listing.tokenRejected;
      // Remembered, not just returned. This is the only place in the app
      // that detects a rejected token WITHOUT needing a pending push, but
      // it runs on the setup screen — which cannot fix anything, since the
      // token field that matters lives in Account -> Folder Sync. Before
      // this line the warning was shown once, during onboarding, and then
      // never again while every upload silently failed.
      await setGitRemoteAccessProblem(tokenRejected ? 'token-rejected' : null);
      onPhase?.({ kind: 'reading' });
      const profiles: ProbedProfile[] = [];
      for (const file of files) {
        const id = file.path.replace(/^profiles\//, '').replace(/\.json$/, '');
        try {
          const parsed = toProbedProfile(id, JSON.parse(file.text) as Record<string, unknown>);
          if (parsed) profiles.push(parsed);
        } catch (err) {
          console.error(`SmartChef: could not parse profile ${id} from the host API:`, err);
        }
      }
      const resolved = applyAdminFallback(profiles);
      resolved.sort((a, b) => a.name.localeCompare(b.name));
      console.info(`[smartchef/probe] host API returned ${resolved.length} profile(s) in ${Date.now() - startedAt}ms`);
      return { supported: true, profiles: resolved, tokenRejected };
    }
  } catch (err) {
    // Rate limited, a token without the right scope, an API that moved —
    // none of which should cost the user their setup when git still works.
    console.warn('SmartChef: host contents API unavailable, falling back to a shallow clone:', err);
  }

  const { dir, gitdir } = await probeCloneDirs();
  // A probe from an interrupted previous attempt would make clone() fail on
  // an already-populated directory.
  await removeRecursively(dir);

  try {
    // isomorphic-git's own onProgress is driven by the server's sideband
    // messages, which it parses WHILE reading the response body — but the
    // native transport downloads the whole body before the renderer sees a
    // byte of it, so nothing can fire until the work is already done. That
    // is why the phase used to sit on "connecting" for the entire
    // operation. The bytes are reported by the layer that actually has
    // them: the native plugin, as it streams the response to disk.
    const startedAt = Date.now();
    // `done` rather than `loaded >= total`: GitHub sends upload-pack with
    // chunked encoding, so total is 0 and that comparison never became
    // true — the screen stayed on "Downloading… 2.1 MB" through all the
    // work that happens after the last byte arrives.
    const stopWatching = observeDownloadProgress((loaded, total, done) =>
      onPhase?.(done && loaded > 1024 * 64 ? { kind: 'preparing' } : { kind: 'downloading', loaded, total }));
    let oid: string | null;
    try {
      oid = await shallowCloneTip(dir, gitdir, config);
    } finally {
      stopWatching();
    }
    console.info(`[smartchef/probe] clone finished in ${Date.now() - startedAt}ms`);
    if (!oid) return { supported: true, profiles: [] }; // reachable, but nothing synced into it yet

    onPhase?.({ kind: 'reading' });
    const readingAt = Date.now();
    const files = await git.listFiles({ fs: gitfs, dir, gitdir, ref: oid, cache: gitCache() });
    const ids = files
      .filter((f) => f.startsWith('profiles/') && f.endsWith('.json'))
      .map((f) => f.slice('profiles/'.length, -'.json'.length));

    const profiles: ProbedProfile[] = [];
    for (const id of ids) {
      try {
        const { blob } = await git.readBlob({ fs: gitfs, dir, gitdir, oid, filepath: `profiles/${id}.json`, cache: gitCache() });
        const parsed = toProbedProfile(id, JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown>);
        if (parsed) profiles.push(parsed);
      } catch (err) {
        // One unreadable profile must not cost the user the others — the
        // full sync that follows will report it properly through
        // mergeBridge.ts's failedEntities.
        console.error(`SmartChef: could not read profile ${id} during first-run probe:`, err);
      }
    }
    const resolved = applyAdminFallback(profiles);
    resolved.sort((a, b) => a.name.localeCompare(b.name));
    console.info(`[smartchef/probe] read ${resolved.length} profile(s) from ${files.length} files in ${Date.now() - readingAt}ms`);
    return { supported: true, profiles: resolved };
  } finally {
    await removeRecursively(dir);
    // The clone this cached objects from is now deleted, so anything held
    // for it is both stale and dead weight before the real sync starts.
    resetGitCache();
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
