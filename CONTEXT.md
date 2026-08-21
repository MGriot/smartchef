# SmartChef Standalone Storage & Sync

Governs how a standalone (server-less) SmartChef installation keeps its own data and exchanges it with other installations belonging to the same user.

## Language

**Local Storage**:
The live database and image files a standalone-mode app instance reads and writes directly during normal use — the entirety of a user's recipes, ingredients, tools, tags, and techniques. Never touched by an external replication tool.
_Avoid_: local database, app data, working copy

**Sync Folder**:
A separate, user-chosen folder holding a bare-style git remote, physically replicated between devices by an external tool (e.g. Syncthing). The app only ever reads and writes it through git operations — never a live database file.
_Avoid_: sync directory, shared folder, mirror folder

**Sync Engine**:
The component on each device that turns Local Storage changes into commits, pushes them to the Sync Folder, and pulls/merges other devices' commits back in.
_Avoid_: gitSync, mirror engine

**Hidden Clone**:
The private, app-managed git working copy each device's Sync Engine actually operates on — distinct from both Local Storage and the Sync Folder. Never seen directly by the user or by any external tool.
_Avoid_: working tree, staging clone

**Structured Merge**:
The Sync Engine's merge strategy: comparing parsed entity JSON (not raw text) against a common ancestor, so non-overlapping field edits combine automatically. Used instead of git's textual merge, which risks leaving unparseable conflict markers inside a JSON file.
_Avoid_: three-way merge, JSON diff

**Conflict**:
An entity where the same field was changed on two devices since their last common sync point. Left pending and excluded from that sync's applied set until the user picks a version — never auto-resolved.
_Avoid_: merge conflict, sync error

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
