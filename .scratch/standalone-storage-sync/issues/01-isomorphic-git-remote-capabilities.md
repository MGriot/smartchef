Type: research
Status: resolved

## Question

Does isomorphic-git support real fetch/push/merge operations against a git remote that lives only as a local folder (no HTTP server), sufficient to implement the Sync Engine as "each device's Hidden Clone treats the Sync Folder as a bare-style git remote, using real git fetch/push" (per issue #4 and ADR 0001)?

Specifically:

(a) Does isomorphic-git's `push`/`fetch` support a `file://`-style or local-filesystem-only remote at all, given it's primarily designed around an injected `http` client for browser/Node HTTP transport — or does reaching a folder-only remote require using its lower-level plumbing (`readObject`/`writeObject`/`resolveRef`/`writeRef`, walking packfiles or loose objects manually) the way the existing `androidMirror.ts`/`gitSync.ts` already does today (manual content-addressed object copy + ref overwrite, not `git.fetch`/`git.push`)?

(b) Does isomorphic-git provide any merge-base / three-way-merge primitive usable as the "common ancestor" input to Structured Merge, or does that have to be implemented from scratch on top of raw object/tree walking?

(c) Are there known limitations running isomorphic-git's plumbing against Capacitor Filesystem (Android private storage) or the SafMirror-backed fs adapter specifically, beyond what the current design already works around?

Report back: what's actually usable off-the-shelf, what has to be hand-rolled, and whether the "bare-style remote" framing in issue #4 is achievable as literally stated or needs adjusting.

## Answer

**Verdict: not achievable as literally stated.** isomorphic-git's `fetch`/`push`/`pull` are hard-locked to `http`/`https` transport — `GitRemoteManager.getRemoteHelperFor` (installed v1.41.4, `frontend/node_modules/isomorphic-git/index.js:9489`) only registers `http`/`https` remote helpers; any other transport, including a folder path, throws `UnknownTransportError`. Corroborated by the still-open upstream [isomorphic-git/isomorphic-git#462](https://github.com/isomorphic-git/isomorphic-git/issues/462), where a maintainer confirms fetch/push/pull require an actual git server.

Adjustment: the Hidden Clone reaches the Sync Folder the same way `androidMirror.ts` already does today — hand-rolled plumbing (manual content-addressed object copy + ref overwrite via `readObject`/`writeObject`/`resolveRef`/`writeRef`), not literal `git.fetch()`/`git.push()` calls. This applies to Electron too, which doesn't get a shortcut here despite direct filesystem access — same plumbing, no HTTP layer either way.

(a) Confirmed above — folder-only remotes are unsupported by the high-level API; low-level plumbing is the only path, and it's already proven in this codebase.

(b) `git.findMergeBase` is real, local-only commit-graph plumbing directly usable for the common-ancestor step. `git.walk` with `TREE()`/`readBlob` can walk ancestor/ours/theirs trees in lockstep (as isomorphic-git's own internal `mergeTree` does). But there is no JSON-aware merge primitive — `git.merge`'s default is line-based `diff3` text merging with conflict markers, exactly what ADR 0001 rejects. A custom `mergeDriver` callback is a valid extension point, but Structured Merge's field-level JSON combine logic must be hand-written on top of `findMergeBase`/`walk`/`readBlob`, either standalone or wired in as that driver.

(c) One confirmed, already-handled requirement: isomorphic-git eagerly binds `readlink`/`symlink` on the fs adapter at construction (`index.js:5150-5189`); `frontend/src/lib/gitfs.ts` already stubs this correctly. No other version-current, isomorphic-git-specific SAF/Capacitor Filesystem blocker was found.

Full findings with citations: [`01-isomorphic-git-remote-capabilities.md`](../research/01-isomorphic-git-remote-capabilities.md) on branch `research/isomorphic-git-remote-capabilities` (commit `d6dc970`).
