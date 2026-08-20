Type: grilling
Blocked by: 03
Status: resolved

## Question

What's the image storage and deduplication format across Local Storage, the Hidden Clone, and the Sync Folder — content-addressed naming (e.g. hash-based filenames) so identical images aren't duplicated across devices, a resize/recompression policy (reuse the existing backup-export WebP recompression approach, or store originals), and how images actually move between the three locations (copied on push/pull, referenced, or something else)?

Depends on ticket 03's answer for what the Hidden Clone concretely contains and how it interacts with the other two locations.

## Answer

- **Rendering**: `Capacitor.convertFileSrc()` against a relative, content-addressed path stored in the entity's image column (e.g. `cover_image_url = "images/<hash>.jpg"`), resolved against Local Storage's base path at render time. Standard, platform-uniform API already available via `@capacitor/core` and the existing `@capacitor-community/electron` dependency — no custom protocol handler needed. This was previously undefined in the codebase (standalone mode had no local image-serving path at all before this ticket).

  **Implementation-time correction**: `convertFileSrc()` itself is *not* actually platform-uniform — `@capacitor/core`'s own fallback for any platform that doesn't inject a native implementation (i.e. Electron/web) is a plain identity passthrough (`(filePath) => filePath`), not a loadable `<img src>` for an arbitrary absolute path. "No custom protocol handler needed" still holds, but Electron needed a different mechanism, not the same call: read the image bytes over the existing `electronFs()` IPC bridge and hand back a `Blob`/object URL instead, with the caller owning `URL.revokeObjectURL` cleanup (no such cleanup is needed on native, where `convertFileSrc()` genuinely does its documented job). See `frontend/src/lib/localImages.ts`'s `resolveImageSrc()`.
- **Naming**: content-addressed (hash of file bytes) in Local Storage from the moment an image is added — not a random id. Same convention used in the Hidden Clone and Sync Folder, so a "copy" is always a plain file copy with no translation step, and identical images are deduped everywhere as a free side effect.
- **Movement**: skip-if-present on both push and pull — copy an image file to the destination only if that exact content-addressed filename doesn't already exist there, mirroring the pattern already proven for git objects in the superseded design.
- **Garbage collection**: none for v1. Orphaned images (no longer referenced by any entity, e.g. after a cover-photo swap) accumulate rather than being cleaned up — same "harmless, never deleted" precedent already accepted for unreferenced git objects. Revisit only if this proves to be a real problem in practice.
