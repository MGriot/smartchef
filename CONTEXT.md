# SmartChef Standalone Storage & Sync

Governs how a standalone (server-less) SmartChef installation keeps its own data and exchanges it with other installations belonging to the same user.

## Language

**Local Storage**:
The live database and image files a standalone-mode app instance reads and writes directly during normal use — the entirety of a user's recipes, ingredients, tools, tags, techniques, ingredient categories and units, with their translations. Never touched by an external replication tool.
_Avoid_: local database, app data, working copy

**Sync Folder**:
A separate, user-chosen folder holding a bare-style git remote, physically replicated between devices by an external tool (e.g. Syncthing). The app only ever reads and writes it through git operations — never a live database file. Applies only to **Folder mode** (see Sync Mode) — a **Git Remote** doesn't have a "folder" at all, just a URL.
_Avoid_: sync directory, shared folder, mirror folder

**Sync Mode**:
Which transport a device's Sync Engine uses to reach other devices — **Folder mode** (a Sync Folder, replicated by an external tool) or **Git Remote mode** (a real git server — GitHub, GitLab, or self-hosted — reached over git's own push/fetch protocol, no external tool involved). Chosen per device, independent of what mode any other device sharing the same history uses.
_Avoid_: sync backend, sync target, transport type (when the context already makes "of what" obvious — use "Sync Mode" for the setting itself)

**Setup File**:
A single encrypted file carrying the *portable* part of one device's sync configuration — Sync Mode, auto-sync interval, and the Git Remote URL/username/token — so a second device can be configured without retyping an access token. Encrypted with a passphrase the user chooses (AES-256-GCM over PBKDF2), in a format only this app parses. Deliberately does **not** contain the Sync Folder, which is a per-device native handle and would be meaningless elsewhere; see [ADR 0005](./docs/adr/0005-encrypted-setup-file.md).
_Avoid_: config file, backup (a Backup is the recipe library; a Setup File contains no recipes at all), credentials file

**Sync Engine**:
The component on each device that turns Local Storage changes into commits, pushes them to the Sync Folder, and pulls/merges other devices' commits back in.
_Avoid_: gitSync, mirror engine

**Hidden Clone**:
The private, app-managed git working copy each device's Sync Engine actually operates on — distinct from both Local Storage and the Sync Folder. Never seen directly by the user or by any external tool.
_Avoid_: working tree, staging clone

**Structured Merge**:
The Sync Engine's merge strategy: comparing parsed, normalized entity JSON (not raw text) against a common ancestor, so non-overlapping field edits combine automatically. The ancestor exists because every merge is committed with two parents. Row ids, row order, JSON spelling and empty-vs-null are not edits. Set fields such as tags merge member by member. Used instead of git's textual merge, which risks leaving unparseable conflict markers inside a JSON file. See [ADR 0006](./docs/adr/0006-git-parented-merges-and-newest-wins.md).
_Avoid_: three-way merge, JSON diff

**Entity File**:
One synced library item as one JSON file in the Hidden Clone, carrying everything the item owns: its row, translations, a recipe's steps and ingredient rows (each with their own translations), and an ingredient's tags. Categories, units, tools, techniques and tags are entity files too, on **portable ids** derived from the name (or a unit's symbol), so they are the same row on every device. A portable id is assigned when the row is created and when a collision is repaired — never recomputed on rename, which is what lets a user-editable name still carry one.
_Avoid_: sync file, export

**Alias**:
An id another device published that this device resolved onto one of its own rows — the same real-world tool, technique or tag created independently on two devices before portable ids, so each minted its own random id and the active-name unique index rejected the other's row on arrival. Permanent, not a repair queue: a device that never upgrades keeps publishing files and references under the old id, and every one of them has to keep resolving. This is also why re-keying a row writes an Alias for the loser id rather than a Deletion Marker — a tombstone would delete that device's live tool.
_Avoid_: id mapping, redirect, merge record (a Structured Merge is about fields, an Alias is about identity)

**Conflict Policy**:
A per-device setting for how a field both devices changed differently is settled. **Newest** (the default) keeps the side edited last. **Ask** turns it into a Conflict. Cases with an obvious answer are settled under either policy: equal values, one side empty, or set fields.
_Avoid_: merge mode, resolution strategy

**Conflict**:
A field that changed differently on two devices since their last common sync point, where the Conflict Policy is Ask, or where Newest can't tell which edit came last. Left pending until the user picks a version. Until then, this device commits the other device's value for that field, so its own value isn't passed off as an edit.
_Avoid_: merge conflict, sync error

**Replace from Synced Data**:
The explicit "take the remote as the truth" action — `git reset --hard` for Local Storage. Synced rows are overwritten, rows only this device has are discarded, and the Hidden Clone moves onto the remote commit. A backup ref of the old history is kept. Distinct from Resync All, which re-pushes this device's rows and therefore only ever merges.
_Avoid_: reset, restore (a Restore is from a Backup)

**Stuck Entity**:
An item from another device that this device has given up trying to save — retried until nothing further could succeed (a duplicate name, a missing column, an unparseable file). Distinct from an ordinary failed write, which is retried on the next cycle: a Stuck Entity is a standing condition the user is shown once and can act on, rather than an error re-reported after every sync forever.
_Avoid_: sync error, failed entity (that one WILL be retried), conflict

**Deletion Marker**:
The existing per-entity tombstone convention — `sync_status = 'deleted'` on recipes/ingredients, `deleted_at` elsewhere — that lets a deletion propagate through Structured Merge like any other field change.
_Avoid_: tombstone, soft delete flag

**Device Record**:
A per-device file in the Sync Folder (id, human-friendly name, platform, last-synced timestamp) that only its own device ever writes — no merge needed, since files are disjoint by writer.
_Avoid_: device registry entry

**Profile**:
A named person sharing a standalone library — a real synced entity (goes through Structured Merge like a recipe or ingredient), so a profile created on one device is pickable on every other device sharing the same Sync Folder. Not the same axis as a Device Record: a Device Record identifies a *device*, one per device, never synced; a Profile identifies a *person*, shared across every device, and any device can have any Profile active on it at a given time (see Active Profile).
_Avoid_: user, account (this app's "account" already means the server-mode multi-user login system — a different, unrelated concept)

**Active Profile**:
Which Profile a given *device* is currently using — a plain local pointer (not synced, not a git-tracked entity), same spirit as a Device Record's own device id. Clearing it (without touching Local Storage, the Sync Folder, or any Profile itself) returns that device to the profile picker.
_Avoid_: current user, logged-in profile

**Offline Cache** (existing, separate concept — not part of this redesign):
Server-mode's read-through cache of the last-known server snapshot plus a write-outbox of queued mutations, used only when a server-backed installation temporarily can't reach its server. Distinct from Local Storage, which is standalone mode's own primary datastore with no server involved at all — the two are easy to conflate by name and should not be.
_Avoid_: local cache (when meaning Local Storage)
