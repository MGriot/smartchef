---
Status: accepted
---

# Hidden Clone and Sync Folder carry full-resolution images

**Context**: The codebase has an established precedent for image handling in sync-adjacent contexts — `backupImages.service.ts` recompresses images to WebP, q82, ≤1600px, specifically to keep manual backup exports small and self-contained. The Hidden Clone's working tree (ADR 0001) is what gets pushed into the Sync Folder and physically replicated by Syncthing, so the same question applied: recompress, or preserve originals?

**Decision**: The Hidden Clone (and therefore the Sync Folder) stores full-resolution, unmodified copies of Local Storage's images — not the recompressed variant. This deliberately breaks from the `backupImages.service.ts` precedent.

**Considered options**: reusing the existing recompression pipeline (rejected — would mean the version of an image that ends up on a user's other devices is a lossy, downsized copy of what they actually uploaded, and the smaller transfer size wasn't judged worth that trade-off).

**Consequences**: Disk footprint and Syncthing transfer size for images are larger than a recompressed approach would produce — an image now exists at full resolution in up to three places (Local Storage, Hidden Clone, Sync Folder) per device. No dedup or resize logic is needed in the Sync Engine's image-handling path; ticket 05 (image storage/dedup format) only needs to settle content-addressed naming and movement mechanics, not resolution policy. Full history at [wayfinder ticket 03](../../.scratch/standalone-storage-sync/issues/03-hidden-clone-lifecycle.md).
