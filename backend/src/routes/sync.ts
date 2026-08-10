// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: CRDT Sync
// Endpoint per la sincronizzazione P2P tra dispositivi
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  registerPeer, getKnownPeers, getActivePeers,
  syncWithPeer, getCurrentClock, applyRemoteOperation,
  type SyncHandshake, type SyncPayload,
} from "../services/mdns.service";
import { getPendingOps } from "../services/crdt/vector-clock";
import { query } from "../db/pool";
import type { CRDTOperation } from "@shared/types/index";

export const syncRouter = Router();

// ── POST /sync/handshake ───────────────────────────────────────────────
// Il peer remoto ci invia il suo clock; rispondiamo con le ops che mancano

syncRouter.post("/handshake", async (req: Request, res: Response) => {
  const schema = z.object({
    deviceId:    z.string(),
    deviceName:  z.string(),
    vectorClock: z.record(z.number()).default({}),
    port:        z.number().int().positive(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { deviceId, deviceName, vectorClock, port } = parsed.data;

  // Registra il peer
  await registerPeer({
    deviceId,
    deviceName,
    ipAddress: req.ip ?? "unknown",
    port,
    lastSeenAt: new Date(),
    vectorClock,
  });

  // Calcola operazioni che il peer non ha
  const pendingOps = await getPendingOps(vectorClock);
  const ourClock   = await getCurrentClock();

  res.json({
    fromDeviceId: process.env.DEVICE_ID ?? "local",
    operations: pendingOps,
    currentClock: ourClock,
  } satisfies SyncPayload);
});

// ── POST /sync/receive ─────────────────────────────────────────────────
// Riceviamo operazioni inviate da un peer

syncRouter.post("/receive", async (req: Request, res: Response) => {
  const schema = z.object({
    fromDeviceId: z.string(),
    operations: z.array(z.object({
      type: z.enum(["insert","update","delete"]),
      entityType: z.enum(["recipe","ingredient","menu","shopping_list"]),
      entityId: z.string().uuid(),
      payload: z.record(z.unknown()),
      clock: z.record(z.number()),
      deviceId: z.string(),
      timestamp: z.string(),
    })),
    currentClock: z.record(z.number()).default({}),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  let applied = 0;
  let conflicts = 0;

  for (const op of parsed.data.operations) {
    try {
      // applyRemoteOperation is idempotent (keyed on device+entity+clock) and
      // both writes the operation to its real table and logs it — mirrors
      // exactly what happens when we pull ops from a peer in syncWithPeer.
      await applyRemoteOperation(op as CRDTOperation);
      applied++;
    } catch (e) {
      console.error(`Conflict applying op ${op.entityId}:`, e);
      conflicts++;
    }
  }

  res.json({ ok: true, applied, conflicts });
});

// ── GET /sync/peers ────────────────────────────────────────────────────

syncRouter.get("/peers", async (_req: Request, res: Response) => {
  const known = await getKnownPeers();
  const active = getActivePeers();
  const activeIds = new Set(active.map((p) => p.deviceId));

  res.json({
    data: known.map((p) => ({ ...p, isActive: activeIds.has(p.deviceId) })),
  });
});

// ── POST /sync/trigger/:deviceId ──────────────────────────────────────
// Forza sync manuale con un peer specifico

syncRouter.post("/trigger/:deviceId", async (req: Request, res: Response) => {
  const peers = await getKnownPeers();
  const peer = peers.find((p) => p.deviceId === req.params.deviceId);
  if (!peer) return res.status(404).json({ error: "Peer non trovato" });

  const result = await syncWithPeer(peer);
  res.json({ ok: true, ...result });
});

// ── GET /sync/clock ────────────────────────────────────────────────────

syncRouter.get("/clock", async (_req: Request, res: Response) => {
  const clock = await getCurrentClock();
  res.json({ data: clock, deviceId: process.env.DEVICE_ID ?? "local" });
});

// ── GET /sync/conflicts ────────────────────────────────────────────────
// Restituisce entità in stato "conflict" che richiedono risoluzione manuale

syncRouter.get("/conflicts", async (_req: Request, res: Response) => {
  const conflicts = await query(
    `SELECT id, title AS name, 'recipe' AS entity_type, crdt_clock, updated_at
     FROM recipes WHERE sync_status='conflict'
     UNION ALL
     SELECT id, name, 'menu' AS entity_type, crdt_clock, updated_at
     FROM menus WHERE sync_status='conflict'
     ORDER BY updated_at DESC`
  );
  res.json({ data: conflicts });
});

// ── POST /sync/resolve ─────────────────────────────────────────────────
// L'utente sceglie quale versione tenere dopo una conflict resolution UI

syncRouter.post("/resolve", async (req: Request, res: Response) => {
  const schema = z.object({
    entityType: z.enum(["recipe","menu","shopping_list"]),
    entityId: z.string().uuid(),
    resolution: z.enum(["keep_local","keep_remote","merge"]),
    mergedPayload: z.record(z.unknown()).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { entityType, entityId, resolution, mergedPayload } = parsed.data;

  if (entityType === "recipe") {
    if (resolution === "keep_local" || resolution === "keep_remote") {
      await query(
        "UPDATE recipes SET sync_status='synced' WHERE id=$1",
        [entityId]
      );
    } else if (resolution === "merge" && mergedPayload) {
      await query(
        `UPDATE recipes SET title=$1, description=$2, tags=$3,
                sync_status='synced', updated_at=now()
         WHERE id=$4`,
        [mergedPayload.title, mergedPayload.description,
         mergedPayload.tags, entityId]
      );
    }
  }

  res.json({ ok: true });
});
