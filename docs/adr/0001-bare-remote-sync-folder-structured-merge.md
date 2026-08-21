---
Status: accepted
---

# Bare-remote Sync Folder with Structured Merge for standalone-mode storage

**Context**: Standalone-mode devices previously shared a single folder that served as both the live git working copy and the thing an external tool (OneDrive/Drive/Syncthing) replicated — coupling live-database integrity to external replication timing, and relying on last-write-wins reconciliation with no real conflict detection.

**Decision**: Local Storage (the live database/images) and the Sync Folder (a separate, externally-replicated location) are now distinct. Each device drives its own Hidden Clone against the Sync Folder as a bare-style git remote using real fetch/push, and merges using Structured Merge (field-level JSON comparison against a common ancestor) rather than git's textual merge — genuine conflicts are surfaced to the user instead of being silently resolved.

**Considered options**: keeping the single-folder mirror model (rejected — couples live data to external replication); git's native textual merge (rejected — a text-level conflict can leave unparseable conflict markers inside a JSON entity file); silent last-write-wins for all conflicts (rejected — risks silently losing a user's edit without their knowledge).

**Consequences**: The Android `SafMirror` native plugin is retained as the low-level SAF file-access layer, but the byte-mirror algorithm built on top of it is replaced entirely. Full history at [issue #4](https://github.com/MGriot/smartchef/issues/4).

**Update (2026-08-20)**: "using real fetch/push" above is conceptually accurate but not literal — isomorphic-git's `fetch`/`push` are hard-locked to http(s) transport and cannot target a folder-only remote (see [wayfinder ticket 01](../../.scratch/standalone-storage-sync/issues/01-isomorphic-git-remote-capabilities.md)). The Hidden Clone reaches the Sync Folder via the same hand-rolled object/ref plumbing `androidMirror.ts` already uses today, not the library's high-level fetch/push API. The push/pull semantics this ADR describes are unchanged; only the mechanism is corrected.
