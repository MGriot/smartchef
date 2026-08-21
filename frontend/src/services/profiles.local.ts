// ════════════════════════════════════════════════════════════════════════
// SmartChef — Household profiles (standalone mode)
// One row per person sharing this standalone library — synced like any
// other entity so a profile created on one device is pickable on every
// other device sharing the same Sync Folder. See lib/standalone.ts for
// which profile a given *device* is currently using (a separate,
// deliberately per-device, never-synced Preferences pointer).
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from "../db/local";

function newId(): string {
  return crypto.randomUUID();
}

// See recipes.local.ts's syncRecipe() for the same fire-and-forget +
// dynamic-import rationale.
async function syncProfile(id: string): Promise<void> {
  try {
    const row = await queryOne<Record<string, unknown>>('SELECT * FROM profiles WHERE id=$1', [id]);
    if (!row) return;
    const { writeEntityFile } = await import('../lib/sync/gitSync');
    await writeEntityFile('profiles', id, row);
  } catch (err) {
    console.error('SmartChef sync (profile) failed:', err);
  }
}

export interface ProfileRow {
  id: string;
  name: string;
  avatar_url: string | null;
  deleted_at: string | null;
}

export async function listProfiles(): Promise<ProfileRow[]> {
  return query<ProfileRow>('SELECT id, name, avatar_url, deleted_at FROM profiles WHERE deleted_at IS NULL ORDER BY created_at');
}

export async function getProfile(id: string): Promise<ProfileRow | null> {
  return queryOne<ProfileRow>('SELECT id, name, avatar_url, deleted_at FROM profiles WHERE id=$1 AND deleted_at IS NULL', [id]);
}

export async function createProfile(name: string, avatarUrl?: string | null): Promise<ProfileRow> {
  const id = newId();
  const trimmed = name.trim();
  await query('INSERT INTO profiles (id, name, avatar_url) VALUES ($1, $2, $3)', [id, trimmed, avatarUrl || null]);
  await syncProfile(id);
  return { id, name: trimmed, avatar_url: avatarUrl || null, deleted_at: null };
}

export async function updateProfile(id: string, name: string, avatarUrl?: string | null): Promise<void> {
  await query('UPDATE profiles SET name=$1, avatar_url=$2, updated_at=now() WHERE id=$3', [name.trim(), avatarUrl || null, id]);
  await syncProfile(id);
}

/** Re-writes every local profile's entity file regardless of whether
 *  anything actually changed — see ingredients.local.ts's
 *  resyncAllIngredients() for why this exists and where it's called from
 *  (Account.tsx's "Change Folder" flow). */
export async function resyncAllProfiles(): Promise<number> {
  const rows = await query<{ id: string }>("SELECT id FROM profiles");
  for (const row of rows) await syncProfile(row.id);
  return rows.length;
}
