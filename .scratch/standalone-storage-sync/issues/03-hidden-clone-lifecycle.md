Type: grilling
Blocked by: 01
Status: resolved

## Question

Where and when is each device's Hidden Clone created (first standalone-profile creation vs. first sync attempt), where does it live per platform (Electron app-data dir vs. Android private storage — and how it coexists with Local Storage, which on Android is also private storage), and what is its disk-footprint policy given images may now exist in up to three places (Local Storage, Hidden Clone working tree, Sync Folder)?

Does the Hidden Clone store full-resolution images or a synced/recompressed variant? Is there ever a need to recreate/reset a Hidden Clone (corruption recovery), and if so what does that flow look like?

Depends on ticket 01's findings on what a Hidden Clone concretely needs to contain (a real git working tree with checked-out files, vs. just an object store) to support real fetch/push.

## Answer

- **Creation timing**: lazy — created only when a Sync Folder is first configured (at profile creation if the user opts in, or later from Account settings), never eagerly for users who skip sync entirely.
- **Location**: Electron → the app's own `userData` directory (e.g. `app.getPath('userData')/sync-clone`), OS-managed and invisible to the user, distinct from the visible `Documents/SmartChef` Local Storage default. Android → a sibling subfolder within the same app-private root Local Storage already uses (`Directory.Data/sync-clone` next to `Directory.Data/SmartChef`) — same storage class, no new platform capability, just a distinct subfolder name.
- **Image resolution**: full-resolution exact copies of Local Storage's images — not recompressed. This is a deliberate deviation from the codebase's existing WebP/q82/≤1600px recompression precedent (`backupImages.service.ts`); see ADR 0003. It directly settles part of ticket 05 (Image storage/dedup format), which should treat resolution policy as already decided and focus only on dedup naming and movement mechanics between the three locations.
- **Push scope**: only entities changed since this device's own last successful sync — comparing each entity's existing `updated_at` against the Device Record's `lastSyncAt` — not a full-library re-serialize on every cycle.
- **Recovery**: a user-facing "Reset Sync" action in Account settings, alongside the existing "Change Folder" action. Wipes the Hidden Clone and re-clones from the Sync Folder if it still has valid history; falls back to a fresh init only if the Sync Folder is also empty/corrupt.

See [ADR 0003](../../../docs/adr/0003-hidden-clone-full-resolution-images.md) for the image-resolution trade-off specifically.
