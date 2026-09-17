// ════════════════════════════════════════════════════════════════════════
// SmartChef — "That cannot be a GitHub token"
//
// Written after a real failure that cost a week of silent non-syncing: a
// token of the form `AQ.Ab8RN6…` — a Google OAuth access token, from an
// entirely different service — was pasted into the git remote's Access
// token field. Nothing in the app had an opinion about it, so it was
// stored, sent to GitHub, and refused. Because the sync repository is
// PUBLIC, every read then fell back to anonymous access and worked
// perfectly; only uploads failed, and only silently.
//
// The cheapest possible guard against a repeat is to notice, at the moment
// the token is typed, that it does not look remotely like a credential for
// the host it is about to be sent to. No network, no latency, no secrets
// leaving the device.
//
// Deliberately ADVISORY. This never blocks a save:
//   - GitHub Enterprise Server and self-hosted git-http-backend accept
//     credentials of whatever shape their admin chose;
//   - GitHub has added token prefixes before (`github_pat_` in 2022) and
//     will again, and a hard block would turn each new one into a bug
//     report that reads "the app refuses my valid token".
// A false negative here costs nothing — the request still goes out and the
// server still answers. A false POSITIVE would lock someone out of their
// own library. So: warn loudly, allow anyway.
// ════════════════════════════════════════════════════════════════════════

import { detectHost } from './hostContentsApi';

/** Every prefix GitHub currently mints, per its own token-format
 *  documentation: personal (classic), fine-grained personal, OAuth, user-
 *  to-server, server-to-server, and refresh. */
const GITHUB_PREFIXES = ['ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];

/** Classic PATs issued before the April 2021 prefix scheme are bare
 *  40-character hex and never expire, so they are still in active use.
 *  Rejecting these would be exactly the false positive this module must
 *  not produce. */
const GITHUB_LEGACY_HEX = /^[0-9a-f]{40}$/;

export interface TokenShapeProblem {
  /** What the host does issue, for the message and for tests to assert on. */
  expectedPrefixes: string[];
  /** One sentence, ready to render. */
  message: string;
}

/** Non-null when `token` cannot plausibly be a credential for the host
 *  `url` points at.
 *
 *  Returns null — meaning "no opinion", never "looks fine" — for:
 *    - an empty token (absence is a different problem; see
 *      GitRemoteAccessProblem's 'no-credentials');
 *    - any host detectHost() does not recognise, i.e. self-hosted and
 *      GitHub Enterprise;
 *    - GitLab. Its deploy tokens are an arbitrary password and its OAuth
 *      tokens are bare hex, so only `glpat-` is recognisable and the rest
 *      are indistinguishable from a typo. Flagging them would block
 *      legitimate setups to catch nothing. */
export function checkTokenShape(url: string, token: string | null): TokenShapeProblem | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;

  const host = detectHost(url);
  if (!host || host.kind !== 'github') return null;

  if (GITHUB_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
  if (GITHUB_LEGACY_HEX.test(trimmed)) return null;

  return {
    expectedPrefixes: ['ghp_', 'github_pat_'],
    message:
      'This does not look like a GitHub token — GitHub tokens begin ghp_ or github_pat_. A token from another ' +
      'service can still read a public repository, so sync will appear to work while every upload fails.',
  };
}
