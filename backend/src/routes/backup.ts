// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Manual whole-library backup export/import
// Reuses folder-sync.service.ts's snapshot format and merge logic — a
// backup is just a snapshot the user downloads/uploads by hand instead of
// exchanging through a watched folder. Independent of SYNC_ENABLED, so it
// works for single-instance users who never turn on Multi-Device Sync.
// Restoring merges by id/updatedAt (last-write-wins), same as peer sync —
// not a destructive wipe-and-reload — so it reuses already-tested code
// instead of a second, riskier path.
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { buildFullSnapshot, mergeSnapshot, Snapshot } from "../services/folder-sync.service";
import { embedSnapshotImages } from "../services/backupImages.service";

export const backupRouter = Router();

// GET /backup/export
backupRouter.get("/export", async (_req: Request, res: Response) => {
  const snapshot = await buildFullSnapshot();
  await embedSnapshotImages(snapshot);
  res.json({ data: snapshot });
});

// POST /backup/import
backupRouter.post("/import", async (req: Request, res: Response) => {
  const snapshot = req.body as Snapshot;
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.recipes)) {
    return res.status(400).json({ error: "That doesn't look like a SmartChef backup file." });
  }

  const summary = { categories: 0, tools: 0, techniques: 0, tags: 0, ingredients: 0, recipes: 0, conflicts: [] as string[] };
  await mergeSnapshot(snapshot, summary, "uploaded backup");
  res.json({ data: summary });
});
