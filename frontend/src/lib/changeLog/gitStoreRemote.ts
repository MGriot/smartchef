// ════════════════════════════════════════════════════════════════════════
// SmartChef — the network half of the git store (lib/changeLog/gitStore.ts):
// isomorphic-git fetch/push of the `smartchef-v2` branch, through the same
// native HTTP client, credentials and error wording as the git era's
// git-remote mode (lib/sync/gitRemoteTransport.ts) — so no CORS, the same
// token, and the same "what to do about it" messages.
// ════════════════════════════════════════════════════════════════════════

import * as git from 'isomorphic-git';
import { nativeHttpClient as http } from '../sync/nativeHttpClient';
import { describeTransportError, gitBasicCredentials, isPushRejection } from '../sync/gitRemoteTransport';
import type { GitRemoteConfig } from '../sync/syncSettings';
import { V2_BRANCH, type GitRemoteOps } from './gitStore';

const REMOTE = 'origin';

/** The branch not existing yet is the normal state of a library no device
 *  has moved to v2 yet — not an error. */
function isMissingBranch(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return !!e && (e.code === 'NotFoundError' || /could not find|not found|no refs|empty repository/i.test(e.message ?? ''));
}

export function isomorphicGitRemote(
  fs: git.PromiseFsClient | git.CallbackFsClient, dir: string, gitdir: string, config: GitRemoteConfig, branch = V2_BRANCH,
): GitRemoteOps {
  const credentials = gitBasicCredentials(config);
  const onAuth = credentials ? () => credentials : undefined;
  const corsProxy = config.corsProxy || undefined;

  return {
    async fetch() {
      await git.addRemote({ fs, dir, gitdir, remote: REMOTE, url: config.url, force: true });
      try {
        const result = await git.fetch({
          fs, http, dir, gitdir, url: config.url, corsProxy, remote: REMOTE,
          ref: branch, remoteRef: branch, singleBranch: true, tags: false, onAuth,
        });
        return result.fetchHead ?? null;
      } catch (err) {
        if (isMissingBranch(err)) return null;
        throw describeTransportError(err, 'fetch');
      }
    },

    async push() {
      try {
        const result = await git.push({
          fs, http, dir, gitdir, url: config.url, corsProxy, remote: REMOTE,
          ref: branch, remoteRef: branch, onAuth,
        });
        return result.ok ? 'ok' : 'rejected';
      } catch (err) {
        if (isPushRejection(err)) return 'rejected';
        throw describeTransportError(err, 'push');
      }
    },
  };
}
