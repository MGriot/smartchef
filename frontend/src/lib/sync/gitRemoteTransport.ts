// ════════════════════════════════════════════════════════════════════════
// SmartChef — Real git-remote transport (GitHub, GitLab, or self-hosted —
// from isomorphic-git's side these are all just "a URL plus credentials",
// so one implementation covers all three; see syncSettings.ts)
//
// Unlike gitObjectTransport.ts's hand-rolled object/ref copying (needed
// because a plain folder can't speak git's protocol), this module uses
// isomorphic-git's own fetch()/push() against a real git server over
// smart HTTP. That server owns ref updates natively — a non-fast-forward
// push is rejected server-side, which is real compare-and-swap, not the
// best-effort manifest/CAS machinery gitObjectTransport.ts needs to
// approximate the same guarantee against a dumb file store. No SAF/cloud-
// drive listing involved either, so the incomplete-pull detection and
// bundle catch-up that exist for the 'folder' mode's known failure modes
// have nothing to catch here — a real git server either has the object or
// it doesn't, and says so.
//
// Writes its fetched ref to the SAME DEFAULT_REMOTE_TRACKING_REF_NAME
// gitObjectTransport.ts's pull path uses (passed as `remote: 'sync-folder'`
// below) — deliberately, so mergeBridge.ts's merge logic and gitSync.ts's
// resolveRef(DEFAULT_REMOTE_TRACKING_REF_NAME) calls need no branching by
// sync mode at all; only how the tracking ref gets there differs.
//
// http here is nativeHttpClient, NOT isomorphic-git/http/web — the latter
// runs requests through the WebView's own fetch(), which is subject to
// the browser's CORS policy; GitHub/GitLab's git-smart-HTTP endpoints
// don't send CORS headers (built for native git clients, not browser JS),
// so that request never even reaches application code, typically
// surfacing as a bare "Failed to fetch". nativeHttpClient routes the
// request through native code (Electron's main process / an Android
// Capacitor plugin) instead, which was never subject to CORS in the first
// place — see its own header for the full reasoning. No CORS proxy is
// needed as a result; corsProxy below is passed through only for a user
// who explicitly configured one anyway (e.g. against a server that somehow
// still needs it), never required by this module itself.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import { gitfs } from '../gitfs';
import { gitCache } from './gitCache';
import { DEFAULT_REMOTE_TRACKING_REF_NAME } from './gitObjectTransport';
import { nativeHttpClient as http } from './nativeHttpClient';
import type { GitRemoteConfig } from './syncSettings';

const REMOTE_NAME = 'sync-folder';
const BRANCH = 'main';

function authFor(config: GitRemoteConfig) {
  if (!config.token) return undefined;
  // Most providers (GitHub, GitLab, self-hosted git-http-backend with
  // Basic Auth) accept any non-empty username alongside a PAT/password —
  // default to the token itself when no username was given, matching
  // GitHub's own documented `https://<token>@github.com/...` shorthand.
  return () => ({ username: config.username || config.token!, password: config.token! });
}

// git.fetch()'s remote/url params are enough to reach the server, but its
// own ref-writing step (updateRemoteRefs) always looks up the refspec to
// apply from *local git config* — `git remote add` populates that in a
// normal git workflow; nothing else in this app ever does. Skipping this
// throws isomorphic-git's own NoRefspecError ("Could not find a fetch
// refspec for remote..."), even though the fetch itself (downloading
// objects) already succeeded. `force: true` makes this idempotent and
// keeps the config's URL current if the user changes it later — cheap
// (a local file write), so calling it every cycle rather than trying to
// detect "did this already run once" is simpler and just as correct.
async function ensureRemoteConfigured(dir: string, gitdir: string, config: GitRemoteConfig): Promise<void> {
  await git.addRemote({ fs: gitfs, dir, gitdir, remote: REMOTE_NAME, url: config.url, force: true });
}

export interface GitRemoteFetchResult {
  /** false when the remote has no commits on `main` yet — a brand-new
   *  empty repo, not an error (same meaning as gitObjectTransport.ts's
   *  PullResult.pulled: false for a fresh Sync Folder). */
  fetched: boolean;
  remoteOid: string | null;
}

export async function fetchGitRemote(
  dir: string,
  gitdir: string,
  config: GitRemoteConfig,
  onProgress?: (loaded: number, total: number) => void
): Promise<GitRemoteFetchResult> {
  await ensureRemoteConfigured(dir, gitdir, config);

  const result = await git.fetch({
    fs: gitfs,
    http,
    cache: gitCache(),
    dir,
    gitdir,
    url: config.url,
    corsProxy: config.corsProxy || undefined,
    remote: REMOTE_NAME,
    ref: BRANCH,
    remoteRef: BRANCH,
    singleBranch: true,
    tags: false,
    onAuth: authFor(config),
    onProgress: onProgress ? (p) => onProgress(p.loaded, p.total) : undefined,
  });

  return { fetched: result.fetchHead !== null, remoteOid: result.fetchHead };
}

export interface GitRemotePushResult {
  /** false when there was no local commit to push yet, or the push was
   *  rejected — see `conflict`. */
  pushed: boolean;
  /** true when the remote rejected the update (non-fast-forward — another
   *  device pushed since this device last fetched). Same meaning as
   *  gitObjectTransport.ts's PushResult.conflict: the caller should
   *  re-fetch, re-merge, and retry rather than force. */
  conflict?: boolean;
}

export async function pushGitRemote(dir: string, gitdir: string, config: GitRemoteConfig): Promise<GitRemotePushResult> {
  try {
    await git.resolveRef({ fs: gitfs, dir, gitdir, ref: 'HEAD' });
  } catch {
    return { pushed: false }; // no local commits yet
  }

  await ensureRemoteConfigured(dir, gitdir, config);

  // force: true is load-bearing, not a shortcut — without it, git.push()
  // throws PushRejectedError ("not a simple fast-forward") on essentially
  // every push after the very first device to ever push, permanently, not
  // as an edge case. Structured Merge (applyMergeIfNeeded() in gitSync.ts)
  // reconciles content field-by-field and commits the result with a
  // single parent — this device's own previous commit — never a real
  // two-parent git merge commit linking back into the remote's history.
  // From git's perspective that's indistinguishable from two branches that
  // diverged and never merged, so its built-in fast-forward check refuses
  // every time, regardless of how fresh the fetch+merge just was. That
  // check exists to stop exactly the kind of blind overwrite this app
  // already guards against a different way: the fetch-merge-push ordering
  // (pull before push, see gitSync.ts) means the commit being pushed was
  // just computed FROM the remote's current state, not blind to it — the
  // same safety folder mode gets from its own manifest/CAS check instead
  // of git ancestry (gitObjectTransport.ts). Forcing here is what actually
  // applies that already-established safety net at the git-protocol
  // level, not a bypass of it.
  const result = await git.push({
    cache: gitCache(),
    fs: gitfs,
    http,
    dir,
    gitdir,
    url: config.url,
    corsProxy: config.corsProxy || undefined,
    remote: REMOTE_NAME,
    ref: BRANCH,
    remoteRef: BRANCH,
    force: true,
    onAuth: authFor(config),
  });

  if (!result.ok) {
    return { pushed: false, conflict: true };
  }
  return { pushed: true };
}

/** Quick reachability/auth check for the settings UI — "Test Connection"
 *  button, not part of the regular sync cycle. Resolves to an error
 *  message on failure, null on success (fetches nothing, just confirms
 *  the server answers and credentials are accepted). */
export async function testGitRemoteConnection(config: GitRemoteConfig): Promise<string | null> {
  try {
    await git.getRemoteInfo({
      http,
      url: config.url,
      corsProxy: config.corsProxy || undefined,
      onAuth: authFor(config),
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Could not reach this git remote';
  }
}

/** Clones ONLY the tip commit into `dir`, with no working tree.
 *
 *  For the first-run profile probe (firstRunProbe.ts) and nothing else —
 *  which is why it takes its own throwaway `dir` rather than touching the
 *  Hidden Clone. Two deliberate restrictions, both load-bearing:
 *
 *  `depth: 1` — a new device otherwise downloads the entire history before
 *  it can show anything. Measured against a real library: a full clone is
 *  13 MB, the same repository at depth 1 is 2.3 MB. Over 80% of what a
 *  first launch was waiting on is history it will never read. The Hidden
 *  Clone is deliberately NOT made shallow by this — a shallow history can
 *  leave findMergeBase() unable to find the true base later, and
 *  mergeBridge.ts turns a missing base into a conflict on every differing
 *  field. Paying 2.3 MB twice is the price of keeping merge semantics
 *  exactly as they are, and it buys the thing that actually matters here:
 *  the full download happens AFTER the user is already in the app.
 *
 *  `noCheckout: true` — a checkout would write all ~517 entity files and
 *  images to disk one at a time through the Filesystem bridge, which is
 *  most of the cost this probe exists to skip. The objects are all that is
 *  needed; the caller reads what it wants with readBlob(). */
export async function shallowCloneTip(
  dir: string,
  gitdir: string,
  config: GitRemoteConfig,
  onProgress?: (loaded: number, total: number) => void
): Promise<string | null> {
  await git.clone({
    fs: gitfs,
    http,
    cache: gitCache(),
    dir,
    gitdir,
    url: config.url,
    corsProxy: config.corsProxy || undefined,
    ref: BRANCH,
    singleBranch: true,
    depth: 1,
    noCheckout: true,
    noTags: true,
    onAuth: authFor(config),
    onProgress: onProgress ? (p) => onProgress(p.loaded, p.total) : undefined,
  });
  try {
    return await git.resolveRef({ fs: gitfs, dir, gitdir, ref: BRANCH });
  } catch {
    // A remote with no commits on `main` yet — a library nobody has synced
    // into. Not an error: the caller shows "create the first profile".
    return null;
  }
}

export { DEFAULT_REMOTE_TRACKING_REF_NAME };
