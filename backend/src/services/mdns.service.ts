// ════════════════════════════════════════════════════════════════════════
// SmartChef — mDNS P2P Discovery Service
// Usa multicast DNS (Bonjour) per trovare altri dispositivi SmartChef
// sulla rete locale senza bisogno di un server centrale
// ════════════════════════════════════════════════════════════════════════

import { query } from "../db/pool";
import type { VectorClock } from "./crdt/vector-clock";
import { getPendingOps, appendOperation, mergeClock } from "./crdt/vector-clock";
import type { CRDTOperation } from "@shared/types/index";

const MDNS_SERVICE_TYPE = "_smartchef._tcp";
const SYNC_PORT = parseInt(process.env.SYNC_PORT ?? "3001", 10);
const DEVICE_ID = process.env.DEVICE_ID ?? `device-${Math.random().toString(36).slice(2, 9)}`;

export interface PeerDevice {
  deviceId: string;
  deviceName: string;
  ipAddress: string;
  port: number;
  lastSeenAt: Date;
  vectorClock: VectorClock;
}

// ── Peer Registry (in-memory + DB) ────────────────────────────────────

const activePeers = new Map<string, PeerDevice>();

export async function registerPeer(peer: PeerDevice): Promise<void> {
  activePeers.set(peer.deviceId, { ...peer, lastSeenAt: new Date() });

  await query(
    `INSERT INTO known_devices (device_id, device_name, last_seen_at, ip_address, port, vector_clock)
     VALUES ($1,$2,now(),$3,$4,$5)
     ON CONFLICT (device_id) DO UPDATE
       SET last_seen_at=now(), ip_address=$3, port=$4, vector_clock=$5`,
    [peer.deviceId, peer.deviceName, peer.ipAddress, peer.port,
     JSON.stringify(peer.vectorClock)]
  );
}

export async function getKnownPeers(): Promise<PeerDevice[]> {
  const rows = await query<{
    device_id: string; device_name: string; last_seen_at: string;
    ip_address: string; port: number; vector_clock: VectorClock;
  }>("SELECT * FROM known_devices ORDER BY last_seen_at DESC");

  return rows.map((r) => ({
    deviceId: r.device_id,
    deviceName: r.device_name,
    ipAddress: r.ip_address,
    port: r.port,
    lastSeenAt: new Date(r.last_seen_at),
    vectorClock: r.vector_clock ?? {},
  }));
}

export function getActivePeers(): PeerDevice[] {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
  return [...activePeers.values()].filter(
    (p) => p.lastSeenAt > fiveMinutesAgo
  );
}

// ── Sync Protocol ──────────────────────────────────────────────────────

export interface SyncHandshake {
  deviceId: string;
  deviceName: string;
  vectorClock: VectorClock;
  port: number;
}

export interface SyncPayload {
  fromDeviceId: string;
  operations: CRDTOperation[];
  currentClock: VectorClock;
}

/**
 * Avvia sincronizzazione con un peer specifico.
 * Protocollo:
 * 1. Invia il nostro vector clock al peer
 * 2. Il peer risponde con le operazioni che non abbiamo
 * 3. Applichiamo le operazioni ricevute
 * 4. Inviamo le nostre operazioni che il peer non ha
 */
export async function syncWithPeer(peer: PeerDevice): Promise<{
  received: number;
  sent: number;
  conflicts: number;
}> {
  const ourClock: VectorClock = await getCurrentClock();

  // Step 1: Invia handshake con il nostro clock
  const handshakeRes = await fetch(
    `http://${peer.ipAddress}:${peer.port}/sync/handshake`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: DEVICE_ID,
        deviceName: process.env.DEVICE_NAME ?? "SmartChef Device",
        vectorClock: ourClock,
        port: SYNC_PORT,
      } satisfies SyncHandshake),
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!handshakeRes.ok) throw new Error(`Handshake failed: ${handshakeRes.status}`);

  const { operations: incomingOps, currentClock: peerClock } =
    (await handshakeRes.json()) as SyncPayload;

  // Step 2: Applica operazioni ricevute
  let received = 0;
  let conflicts = 0;

  for (const op of incomingOps) {
    try {
      await applyRemoteOperation(op);
      received++;
    } catch (e) {
      console.error(`Conflict applying op ${op.entityId}:`, e);
      conflicts++;
    }
  }

  // Step 3: Invia le nostre operazioni che il peer non ha
  const ourPendingOps = await getPendingOps(peerClock);
  if (ourPendingOps.length > 0) {
    await fetch(`http://${peer.ipAddress}:${peer.port}/sync/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromDeviceId: DEVICE_ID,
        operations: ourPendingOps,
        currentClock: ourClock,
      } satisfies SyncPayload),
      signal: AbortSignal.timeout(30_000),
    });
  }

  // Aggiorna il clock nel registro dei peer
  await registerPeer({ ...peer, vectorClock: mergeClock(ourClock, peerClock) });

  return { received, sent: ourPendingOps.length, conflicts };
}

/**
 * Applica un'operazione CRDT remota al DB locale
 */
export async function applyRemoteOperation(op: CRDTOperation): Promise<void> {
  // Controlla se l'operazione è già stata applicata
  const existing = await query(
    "SELECT id FROM crdt_operations WHERE device_id=$1 AND entity_id=$2 AND vector_clock=$3",
    [op.deviceId, op.entityId, JSON.stringify(op.clock)]
  );
  if (existing.length > 0) return; // idempotente

  // Applica l'operazione al DB
  switch (op.entityType) {
    case "recipe":
      await applyRecipeOp(op);
      break;
    case "menu":
      await applyMenuOp(op);
      break;
    case "shopping_list":
      await applyShoppingOp(op);
      break;
  }

  // Persisti l'operazione nel log CRDT
  await appendOperation(op);
}

async function applyRecipeOp(op: CRDTOperation): Promise<void> {
  const p = op.payload;
  if (op.type === "delete") {
    await query(
      "UPDATE recipes SET sync_status='deleted', crdt_clock=$1 WHERE id=$2",
      [JSON.stringify(op.clock), op.entityId]
    );
    return;
  }
  // Upsert con clock merge
  await query(
    `INSERT INTO recipes (id, title, description, difficulty, servings, tags,
       prep_time_min, cook_time_min, source_url, is_component,
       crdt_clock, sync_status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'synced',now())
     ON CONFLICT (id) DO UPDATE
       SET title=$2, description=$3, difficulty=$4, servings=$5, tags=$6,
           prep_time_min=$7, cook_time_min=$8, source_url=$9,
           is_component=$10, crdt_clock=$11, sync_status='synced', updated_at=now()`,
    [op.entityId, p.title, p.description, p.difficulty, p.servings,
     p.tags, p.prepTimeMin, p.cookTimeMin, p.sourceUrl, p.isComponent,
     JSON.stringify(op.clock)]
  );
}

async function applyMenuOp(op: CRDTOperation): Promise<void> {
  const p = op.payload;
  if (op.type === "delete") {
    await query("DELETE FROM menus WHERE id=$1", [op.entityId]);
    return;
  }
  await query(
    `INSERT INTO menus (id, name, week_start, notes, crdt_clock, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (id) DO UPDATE
       SET name=$2, week_start=$3, notes=$4, crdt_clock=$5, updated_at=now()`,
    [op.entityId, p.name, p.weekStart, p.notes, JSON.stringify(op.clock)]
  );
}

async function applyShoppingOp(op: CRDTOperation): Promise<void> {
  const p = op.payload;
  if (op.type === "delete") {
    await query("DELETE FROM shopping_lists WHERE id=$1", [op.entityId]);
    return;
  }
  await query(
    `INSERT INTO shopping_lists (id, menu_id, name, crdt_clock, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (id) DO UPDATE
       SET name=$3, crdt_clock=$4, updated_at=now()`,
    [op.entityId, p.menuId, p.name, JSON.stringify(op.clock)]
  );
}

/** Calcola il vector clock corrente aggregando tutti gli ops del device */
async function getCurrentClock(): Promise<VectorClock> {
  const rows = await query<{ device_id: string; max_clock: VectorClock }>(
    `SELECT device_id,
            jsonb_build_object(device_id, MAX((vector_clock->>device_id)::int)) AS max_clock
     FROM crdt_operations
     GROUP BY device_id`
  );

  let clock: VectorClock = {};
  for (const row of rows) {
    clock = mergeClock(clock, row.max_clock ?? {});
  }
  return clock;
}

// ── Broadcast Discovery ────────────────────────────────────────────────

/**
 * Avvia il ciclo di sincronizzazione periodica con tutti i peer attivi.
 * In produzione si userebbe multicastDNS (libreria 'mdns' o 'bonjour').
 * Qui implementiamo il protocollo HTTP di sync; la discovery mDNS
 * richiederebbe accesso a socket UDP raw (non disponibile in container).
 */
export function startSyncLoop(intervalMs = 30_000): NodeJS.Timeout {
  return setInterval(async () => {
    const peers = getActivePeers();
    for (const peer of peers) {
      try {
        const result = await syncWithPeer(peer);
        console.log(
          `🔄 Sync con ${peer.deviceName}: +${result.received} ricevute, ` +
          `+${result.sent} inviate, ${result.conflicts} conflitti`
        );
      } catch (e) {
        console.warn(`⚠️ Sync fallita con ${peer.deviceName}:`, (e as Error).message);
        activePeers.delete(peer.deviceId);
      }
    }
  }, intervalMs);
}

export { DEVICE_ID, getCurrentClock };
