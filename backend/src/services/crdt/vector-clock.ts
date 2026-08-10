// ════════════════════════════════════════════════════════════════════════
// SmartChef — CRDT: Vector Clock Engine
// Implementa Last-Write-Wins con vector clock per la gestione
// dei conflitti distribuiti tra dispositivi offline-first
// ════════════════════════════════════════════════════════════════════════

import { query } from "../../db/pool";
import { v4 as uuidv4 } from "uuid";
import type { CRDTOperation, UUID } from "@shared/types/index";

export type VectorClock = Record<string, number>;

// ── Operazioni su Vector Clock ─────────────────────────────────────────

/** Incrementa il contatore del dispositivo locale */
export function tickClock(clock: VectorClock, deviceId: string): VectorClock {
  return { ...clock, [deviceId]: (clock[deviceId] ?? 0) + 1 };
}

/** Merge: prende il massimo per ogni device */
export function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const result: VectorClock = { ...a };
  for (const [device, val] of Object.entries(b)) {
    result[device] = Math.max(result[device] ?? 0, val);
  }
  return result;
}

/**
 * Confronta due vector clock.
 * Ritorna:
 *  -1 → a è causalmente precedente a b (a < b)
 *   1 → a è causalmente successivo a b  (a > b)
 *   0 → a e b sono concorrenti (CONFLITTO)
 */
export function compareClock(a: VectorClock, b: VectorClock): -1 | 0 | 1 {
  const allDevices = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGtB = false;
  let bGtA = false;

  for (const dev of allDevices) {
    const av = a[dev] ?? 0;
    const bv = b[dev] ?? 0;
    if (av > bv) aGtB = true;
    if (bv > av) bGtA = true;
  }

  if (aGtB && !bGtA) return 1;
  if (bGtA && !aGtB) return -1;
  if (!aGtB && !bGtA) return 0; // identici
  return 0; // concorrenti = conflitto
}

/** True se a è causalmente "dopo" b (o uguale) */
export function isDescendant(a: VectorClock, b: VectorClock): boolean {
  return compareClock(a, b) >= 0;
}

// ── Persistenza Operazioni ─────────────────────────────────────────────

export async function appendOperation(op: Omit<CRDTOperation, "timestamp">): Promise<void> {
  await query(
    `INSERT INTO crdt_operations
       (id, device_id, entity_type, entity_id, op_type, payload, vector_clock)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      uuidv4(),
      op.deviceId,
      op.entityType,
      op.entityId,
      op.type,
      JSON.stringify(op.payload),
      JSON.stringify(op.clock),
    ]
  );
}

/** Carica operazioni non ancora sincronizzate con un dispositivo */
export async function getPendingOps(
  sinceClocks: VectorClock
): Promise<CRDTOperation[]> {
  // Prende tutte le operazioni "più recenti" rispetto al clock del richiedente
  type OpRow = {
    id: UUID; device_id: string; entity_type: string; entity_id: UUID;
    op_type: string; payload: unknown; vector_clock: VectorClock; applied_at: string;
  };
  const rows = await query<OpRow>(
    `SELECT * FROM crdt_operations
     WHERE synced = false
     ORDER BY applied_at ASC
     LIMIT 500`
  );

  // Filtra lato JS le operazioni che il richiedente non ha ancora visto
  return rows
    .filter((row) => {
      const rowClock = row.vector_clock as VectorClock;
      // Includi se l'operazione è "dopo" il clock dichiarato dal richiedente
      return !isDescendant(sinceClocks, rowClock);
    })
    .map((row) => ({
      type: row.op_type as CRDTOperation["type"],
      entityType: row.entity_type as CRDTOperation["entityType"],
      entityId: row.entity_id,
      payload: row.payload as Record<string, unknown>,
      clock: row.vector_clock,
      deviceId: row.device_id,
      timestamp: row.applied_at,
    }));
}

export async function markOpsSynced(deviceId: string): Promise<void> {
  await query(
    "UPDATE crdt_operations SET synced=true WHERE device_id=$1 AND synced=false",
    [deviceId]
  );
}

// ── Conflict Detection & Resolution ───────────────────────────────────

export interface ConflictInfo {
  entityType: string;
  entityId: UUID;
  localClock: VectorClock;
  remoteClock: VectorClock;
  localPayload: Record<string, unknown>;
  remotePayload: Record<string, unknown>;
  /** Campi che divergono tra le due versioni */
  conflictingFields: string[];
}

/**
 * Rileva conflitti tra la versione locale di un'entità e quella remota.
 * Usa LWW (Last-Write-Wins) come default; restituisce conflitti strutturali
 * da risolvere manualmente tramite UI.
 */
export function detectConflicts(
  local: { clock: VectorClock; data: Record<string, unknown> },
  remote: { clock: VectorClock; data: Record<string, unknown> }
): ConflictInfo | null {
  const cmp = compareClock(local.clock, remote.clock);

  // Nessun conflitto se uno è chiaramente più recente
  if (cmp !== 0) return null;

  // Conflitto concorrente: trova i campi che divergono
  const allFields = new Set([
    ...Object.keys(local.data),
    ...Object.keys(remote.data),
  ]);

  const conflictingFields: string[] = [];
  for (const field of allFields) {
    if (JSON.stringify(local.data[field]) !== JSON.stringify(remote.data[field])) {
      conflictingFields.push(field);
    }
  }

  if (!conflictingFields.length) return null;

  return {
    entityType: "unknown",
    entityId: (local.data.id as UUID) ?? "",
    localClock: local.clock,
    remoteClock: remote.clock,
    localPayload: local.data,
    remotePayload: remote.data,
    conflictingFields,
  };
}

/**
 * Risoluzione automatica LWW: vince l'operazione con il timestamp più alto
 * sui campi in conflitto. Ritorna il payload "vincente" merged.
 */
export function resolveLWW(
  local: { clock: VectorClock; data: Record<string, unknown>; ts: number },
  remote: { clock: VectorClock; data: Record<string, unknown>; ts: number }
): Record<string, unknown> {
  if (remote.ts > local.ts) return { ...local.data, ...remote.data };
  return { ...remote.data, ...local.data };
}
