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
// dynamic-import rationale — also exported for conflicts.local.ts, same
// reason as ingredients.local.ts's syncIngredient()/syncTool().
export async function syncProfile(id: string): Promise<void> {
  try {
    const row = await queryOne<Record<string, unknown>>('SELECT * FROM profiles WHERE id=$1', [id]);
    if (!row) return;
    const { writeEntityFile } = await import('../lib/sync/gitSync');
    await writeEntityFile('profiles', id, row);
  } catch (err) {
    console.error('SmartChef sync (profile) failed:', err);
  }
}

export type ProfileRole = 'admin' | 'user';

export interface ProfileRow {
  id: string;
  name: string;
  avatar_url: string | null;
  role: ProfileRole;
  deleted_at: string | null;
}

export async function listProfiles(): Promise<ProfileRow[]> {
  return query<ProfileRow>('SELECT id, name, avatar_url, role, deleted_at FROM profiles WHERE deleted_at IS NULL ORDER BY created_at');
}

export async function getProfile(id: string): Promise<ProfileRow | null> {
  return queryOne<ProfileRow>('SELECT id, name, avatar_url, role, deleted_at FROM profiles WHERE id=$1 AND deleted_at IS NULL', [id]);
}

/** Every non-deleted admin, for the "would this leave zero admins" guards
 *  below — shared by updateProfileRole() and deleteProfile(). */
async function countOtherAdmins(excludingId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    "SELECT id FROM profiles WHERE role='admin' AND deleted_at IS NULL AND id != $1",
    [excludingId]
  );
  return rows.length;
}

export async function createProfile(name: string, avatarUrl?: string | null): Promise<ProfileRow> {
  const id = newId();
  const trimmed = name.trim();
  // First profile ever on a fresh library becomes admin automatically —
  // every subsequent one starts as a plain user. See db/local.ts's comment
  // on profiles.role for why this is a UX guardrail, not real access control.
  const existing = await queryOne<{ count: number }>('SELECT COUNT(*) as count FROM profiles WHERE deleted_at IS NULL');
  const role: ProfileRole = (existing?.count ?? 0) === 0 ? 'admin' : 'user';
  await query('INSERT INTO profiles (id, name, avatar_url, role) VALUES ($1, $2, $3, $4)', [id, trimmed, avatarUrl || null, role]);
  await syncProfile(id);
  return { id, name: trimmed, avatar_url: avatarUrl || null, role, deleted_at: null };
}

export async function updateProfile(id: string, name: string, avatarUrl?: string | null): Promise<void> {
  await query('UPDATE profiles SET name=$1, avatar_url=$2, updated_at=now() WHERE id=$3', [name.trim(), avatarUrl || null, id]);
  await syncProfile(id);
}

/** Promotes/demotes a profile. Blocks demoting the last remaining admin, and
 *  blocks a profile demoting itself (an admin must have someone else do it) —
 *  same two rules the server-mode equivalent enforces in backend/src/routes/auth.ts. */
export async function updateProfileRole(id: string, role: ProfileRole, actingProfileId: string | null): Promise<void> {
  if (role === 'user') {
    const target = await getProfile(id);
    if (target?.role === 'admin') {
      if (id === actingProfileId) {
        throw new Error("You can't demote yourself — ask another admin to do it");
      }
      if ((await countOtherAdmins(id)) === 0) {
        throw new Error("Can't demote the last admin");
      }
    }
  }
  await query('UPDATE profiles SET role=$1, updated_at=now() WHERE id=$2', [role, id]);
  await syncProfile(id);
}

/** Soft-deletes a profile — same convention as tools/tags/ingredient_categories
 *  (deleted_at, not a hard DELETE). Recipes/cook-log entries this profile
 *  created are never affected: recipes.creator_name / cook_log.cooked_by_name
 *  are plain denormalized TEXT, not a foreign key to profiles.id, so there is
 *  nothing to orphan or reassign. Blocks deleting the caller's own active
 *  profile and the last remaining admin, mirroring updateProfileRole() above. */
export async function deleteProfile(id: string, actingProfileId: string | null): Promise<void> {
  const target = await getProfile(id);
  if (!target) return;
  if (id === actingProfileId) {
    throw new Error("You can't delete the profile you're currently using — switch profiles first");
  }
  if (target.role === 'admin' && (await countOtherAdmins(id)) === 0) {
    throw new Error("Can't delete the last admin");
  }
  await query('UPDATE profiles SET deleted_at=now(), updated_at=now() WHERE id=$1', [id]);
  await syncProfile(id);
}

/** Re-writes every local profile's entity file regardless of whether
 *  anything actually changed — see ingredients.local.ts's
 *  resyncAllIngredients() for why this exists and where it's called from
 *  (Account.tsx's "Change Folder" flow). */
export async function resyncAllProfiles(onProgress?: (done: number, total: number) => void): Promise<number> {
  const rows = await query<{ id: string }>("SELECT id FROM profiles");
  for (let i = 0; i < rows.length; i++) {
    await syncProfile(rows[i].id);
    onProgress?.(i + 1, rows.length);
  }
  return rows.length;
}
