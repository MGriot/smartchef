// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Folder-based Multi-Device Sync status/control
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import {
  SYNC_ENABLED, runSyncCycle, getLastLocalSnapshotMeta, listPeers, buildFullSnapshot,
} from "../services/folder-sync.service";
import { DEVICE_ID, DEVICE_NAME } from "../services/device-identity.service";

export const syncFolderRouter = Router();

// GET /sync-folder/snapshot
// Full-library snapshot as JSON, straight over HTTP — no filesystem folder
// involved. Used by the native app to seed/refresh its local offline
// cache. Independent of SYNC_ENABLED: that flag gates the folder-based
// desktop-to-desktop sync loop, but a phone pulling its own read cache is
// a different, always-available concern.
syncFolderRouter.get("/snapshot", async (_req: Request, res: Response) => {
  const snapshot = await buildFullSnapshot();
  res.json({ data: snapshot });
});

// GET /sync-folder/status
syncFolderRouter.get("/status", async (_req: Request, res: Response) => {
  if (!SYNC_ENABLED) {
    return res.json({ data: { enabled: false, deviceId: DEVICE_ID, deviceName: DEVICE_NAME } });
  }

  const [lastLocal, peers] = await Promise.all([getLastLocalSnapshotMeta(), listPeers()]);
  res.json({
    data: {
      enabled: true,
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      lastSyncAt: lastLocal?.exportedAt ?? null,
      peers,
    },
  });
});

// POST /sync-folder/sync-now
syncFolderRouter.post("/sync-now", async (_req: Request, res: Response) => {
  if (!SYNC_ENABLED) return res.status(400).json({ error: "Folder sync is not enabled on this instance" });

  try {
    const result = await runSyncCycle();
    res.json({ data: result });
  } catch (err) {
    console.error("Manual sync failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Sync failed" });
  }
});
