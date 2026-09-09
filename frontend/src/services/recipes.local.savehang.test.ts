// ════════════════════════════════════════════════════════════════════════
// A recipe save must finish even when sync never does.
//
// Reported as "after pressing save everything freezes and it never closes
// edit mode". Cause: every save awaited syncRecipe() -> writeEntityFile(),
// which goes through gitSync's ONE shared queue, and nothing in the sync
// transports has a timeout (nativeHttpClient, gitRemoteTransport,
// electronRemoteTransport, androidRemoteTransport — none). A single push or
// fetch against an unreachable remote holds that queue forever, so every
// later save blocked forever too. RecipeDetail.tsx's handleSave then never
// reached setMode('view') nor its `finally` setSaving(false), leaving the
// editor open on a recipe SQLite had in fact already written.
//
// The guarantee this locks in is deliberately about the *hang*, not about
// speed: writeEntityFile here never settles at all, which no timeout value
// would rescue. If someone re-adds `await` to a save path, this test hangs
// and then fails on the timeout below rather than passing quietly.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

/** Resolves when writeEntityFile has been entered, so the test can prove the
 *  sync was genuinely started (not silently skipped) while still never
 *  letting it finish. */
let entered: () => void;
const enteredSync = new Promise<void>((resolve) => { entered = resolve; });

vi.mock('../lib/sync/gitSync', () => ({
  // Never settles — stands in for a git push hanging on a dead remote.
  writeEntityFile: vi.fn(() => {
    entered();
    return new Promise<void>(() => {});
  }),
  logIfSlow: () => {},
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        execute: async (sql: string, transaction = true) => {
          if (!transaction) { db.exec(sql); return; }
          db.exec('BEGIN');
          try { db.exec(sql); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
        },
        query: async (sql: string, params: unknown[] = []) => ({ values: db.prepare(sql).all(...(params as never[])) }),
        run: async (sql: string, params: unknown[] = []) => { db.prepare(sql).run(...(params as never[])); },
      }),
      retrieveConnection: async () => { throw new Error('not expected — one connection, created once'); },
    };
  }),
}));

vi.mock('../lib/standalone', () => ({ getStandaloneProfile: async () => ({ name: 'Matteo' }) }));

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

describe('saving while sync is wedged', () => {
  it('createRecipe resolves even though writeEntityFile never settles', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    const { createRecipe } = await import('./recipes.local');

    const created = await createRecipe(
      { title: 'Maionese piccante', servings: 2, steps: [{ stepNumber: 1, description: 'Frullare.' }] } as never,
      'Matteo'
    );
    expect(created.id).toBeTruthy();
    await enteredSync; // the sync really was kicked off, just not waited on
  }, 10_000);

  it('updateRecipe resolves, and the edit is durably in SQLite', async () => {
    const { initLocalSchema, queryOne } = await import('../db/local');
    await initLocalSchema();
    const { createRecipe, updateRecipe } = await import('./recipes.local');

    const { id } = await createRecipe({ title: 'Maionese piccante', servings: 2 } as never, 'Matteo');
    await updateRecipe(id, { title: 'Maionese piccante (rivista)', servings: 4 } as never);

    // The point of the fix: the user's data is committed even though the
    // Hidden Clone write is still hanging.
    const row = await queryOne<{ title: string; servings: number }>('SELECT title, servings FROM recipes WHERE id=$1', [id]);
    expect(row?.title).toBe('Maionese piccante (rivista)');
    expect(row?.servings).toBe(4);
  }, 10_000);

  it('deleteRecipe resolves too', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    const { createRecipe, deleteRecipe } = await import('./recipes.local');

    const { id } = await createRecipe({ title: 'Da eliminare', servings: 1 } as never, 'Matteo');
    await expect(deleteRecipe(id)).resolves.toBeUndefined();
  }, 10_000);

  it('an ingredient save resolves as well — same shared queue', async () => {
    const { initLocalSchema, query } = await import('../db/local');
    await initLocalSchema();
    await query('INSERT INTO ingredient_categories (id, name) VALUES ($1, $2)', ['cat-1', 'Test Category']);

    const { createIngredient, updateIngredient } = await import('./ingredients.local');
    const { id } = await createIngredient({ name: 'Senape', categoryId: 'cat-1' } as never);
    await expect(updateIngredient(id, { name: 'Senape di Digione', categoryId: 'cat-1' } as never)).resolves.toBeUndefined();
  }, 10_000);
});
