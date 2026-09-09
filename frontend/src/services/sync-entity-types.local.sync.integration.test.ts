// ════════════════════════════════════════════════════════════════════════
// Real-SQLite check that every synced entity type in mergeBridge.ts's
// ENTITY_DIRS (ingredients.local.sync.integration.test.ts only ever covered
// 'ingredient') actually lands via createEntity() against the app's real
// schema — most importantly 'tool', because recipe_tools.tool_id is a real
// "REFERENCES tools(id)" foreign key (unlike recipe_ingredients.unit_id,
// which was deliberately dropped in the 2026-08-25 FK fix). That FK is only
// safe because mergeBridge.ts processes tools (a leaf type) before recipes
// — this test proves that ordering actually works against a real SQLite
// engine, the same way the FK-drop fix was verified, instead of trusting
// the ordering logic's own (fully-mocked) unit test to also stand in for
// the real-schema write path.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: vi.fn().mockImplementation(function SQLiteConnection() {
    return {
      isConnection: async () => ({ result: false }),
      createConnection: async () => ({
        open: async () => {},
        // transaction defaults to true, matching the real plugin's
        // execute() signature — see ingredients.local.sync.integration.
        // test.ts's identical mock for the caveat: this does NOT reproduce
        // the real dropDanglingForeignKeys() transaction-wrapping
        // regression (node:sqlite's PRAGMA-inside-a-transaction behavior
        // differs from the real Electron backend).
        execute: async (sql: string, transaction = true) => {
          if (!transaction) {
            db.exec(sql);
            return;
          }
          db.exec('BEGIN');
          try {
            db.exec(sql);
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
        },
        query: async (sql: string, params: unknown[] = []) => {
          const stmt = db.prepare(sql);
          return { values: stmt.all(...(params as never[])) };
        },
        run: async (sql: string, params: unknown[] = []) => {
          db.prepare(sql).run(...(params as never[]));
        },
      }),
      retrieveConnection: async () => {
        throw new Error('not expected in this test — one connection, created once');
      },
    };
  }),
}));

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

describe('every ENTITY_DIRS type survives createEntity() against real SQLite', () => {
  it('creates a tool, a tag, and a technique from a remote entity JSON', async () => {
    const { initLocalSchema, queryOne } = await import('../db/local');
    await initLocalSchema();
    const { createEntity, entityExists } = await import('./conflicts.local');

    await createEntity('tool', 'tool-1', { id: 'tool-1', name: 'Frullatore', category: 'Elettrodomestici' });
    await createEntity('tag', 'tag-1', { id: 'tag-1', name: 'Vegetariano', group_name: 'Dieta' });
    await createEntity('technique', 'technique-1', { id: 'technique-1', name: 'Soffriggere' });

    expect(await entityExists('tool', 'tool-1')).toBe(true);
    expect(await entityExists('tag', 'tag-1')).toBe(true);
    expect(await entityExists('technique', 'technique-1')).toBe(true);
    expect((await queryOne('SELECT * FROM tools WHERE id=$1', ['tool-1']))).not.toBeNull();
    expect((await queryOne('SELECT * FROM tags WHERE id=$1', ['tag-1']))).not.toBeNull();
    expect((await queryOne('SELECT * FROM techniques WHERE id=$1', ['technique-1']))).not.toBeNull();
  });

  it('writes a synced recipe\'s recipe_tools row against a real REFERENCES tools(id) FK, when the tool was created first (mergeBridge.ts\'s leaf-types-before-recipes order)', async () => {
    const { initLocalSchema, query } = await import('../db/local');
    await initLocalSchema();
    const { createEntity } = await import('./conflicts.local');

    await createEntity('tool', 'tool-1', { id: 'tool-1', name: 'Frullatore' });
    await expect(
      createEntity('recipe', 'recipe-1', {
        id: 'recipe-1',
        title: 'Frullato di frutta',
        servings: 2,
        toolIds: ['tool-1'],
        steps: [
          {
            id: 'step-1', step_number: 1, description: 'Frulla tutto',
            tool_ids: '["tool-1"]', technique_ids: '["technique-1"]',
          },
        ],
      })
    ).resolves.not.toThrow();

    const toolRows = await query('SELECT * FROM recipe_tools WHERE recipe_id=$1', ['recipe-1']);
    expect(toolRows).toHaveLength(1);
    expect((toolRows[0] as { tool_id: string }).tool_id).toBe('tool-1');
  });

  it('throws writing recipe_tools when the referenced tool does not exist yet — documents why mergeBridge.ts must create tools before recipes, not just recipes before nothing', async () => {
    const { initLocalSchema } = await import('../db/local');
    await initLocalSchema();
    const { createEntity } = await import('./conflicts.local');

    await expect(
      createEntity('recipe', 'recipe-2', {
        id: 'recipe-2',
        title: 'Recipe referencing a tool that never synced',
        servings: 1,
        toolIds: ['tool-that-does-not-exist'],
      })
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
