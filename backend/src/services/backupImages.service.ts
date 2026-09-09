// ════════════════════════════════════════════════════════════════════════
// SmartChef — Backup export: embed images as base64 data: URIs
// Manual backup export (backend/src/routes/backup.ts's GET /export) only —
// NOT buildFullSnapshot()'s other callers (folder-sync's continuous peer
// sync writes/reads the same server, so relative /uploads/ URLs already
// resolve fine there; embedding on every sync tick would be pure waste).
//
// A restored backup can land on a standalone device with no server at all
// (see frontend/src/services/backup.local.ts) — a relative /uploads/<file>
// URL is then meaningless, and an *external* URL a user pasted into an
// image field only ever works while that device has network access to
// wherever it points. Embedding every image at export time, server-side,
// makes the file fully self-contained regardless of where or when it's
// later restored — done here rather than client-side specifically to
// avoid CORS: a browser's own fetch() of an arbitrary third-party image
// URL is routinely blocked by the *remote* server's CORS policy (unlike
// <img src>, which browsers never gate this way), but this route has no
// such restriction fetching the same URL server-side.
//
// Every embedded image is normalized through the same resize+recompress
// pipeline uploads.ts already uses for user-uploaded images — caps size
// and re-encodes as WebP, so a full-resolution external image doesn't
// bloat the backup file, and this app's own already-optimized /uploads/
// files pass through as a near-no-op (already within these bounds).
// ════════════════════════════════════════════════════════════════════════

import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { UPLOAD_DIR } from "./uploadDir";
import type { Snapshot } from "./folder-sync.service";

async function loadImageBytes(url: string): Promise<Buffer | null> {
  if (url.startsWith("/uploads/")) {
    try {
      return await fs.readFile(path.join(UPLOAD_DIR, url.slice("/uploads/".length)));
    } catch {
      return null; // referenced file no longer exists on disk — skip, don't fail the export
    }
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null; // unreachable, timed out, or not actually an image — best-effort
    }
  }
  return null; // already a data: URI, or some other scheme — nothing to embed
}

async function toEmbeddedDataUri(url: string): Promise<string | null> {
  const bytes = await loadImageBytes(url);
  if (!bytes) return null;
  try {
    const webp = await sharp(bytes)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return `data:image/webp;base64,${webp.toString("base64")}`;
  } catch {
    return null; // not a decodable image (broken URL content, non-image response, etc.)
  }
}

export async function embedSnapshotImages(snapshot: Snapshot): Promise<void> {
  const cache = new Map<string, string | null>();
  const embed = async (url?: string | null): Promise<string | null | undefined> => {
    if (!url || url.startsWith("data:")) return url;
    if (!cache.has(url)) cache.set(url, await toEmbeddedDataUri(url));
    return cache.get(url) ?? url; // embedding failed — leave the original URL rather than losing the reference
  };

  for (const r of snapshot.recipes) {
    if (r.coverImageUrl) r.coverImageUrl = (await embed(r.coverImageUrl)) ?? null;
    for (const s of r.steps) {
      if (s.imageUrl) s.imageUrl = (await embed(s.imageUrl)) ?? null;
    }
  }
  for (const group of [snapshot.ingredients, snapshot.tools, snapshot.techniques]) {
    for (const item of group) {
      if (item.imageUrls?.length) {
        item.imageUrls = await Promise.all(item.imageUrls.map((u) => embed(u).then((v) => v ?? u)));
      }
    }
  }
}
