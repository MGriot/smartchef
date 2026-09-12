// ═════════════════════════════════════════════════════════════════════════
// SmartChef — Tag group labels and catalogue merges, against real SQLite
//
// These are here together for the same reason: they are the library
// operations that rewrite references held OUTSIDE the row being changed,
// which is exactly what a mocked query layer papers over. Run against
// node:sqlite, like the other integration tests here — this engine enforces
// constraints the mocks don't (see db/local.ts's dropDanglingForeignKeys()
// for what that has cost before).
//
// Tag groups: tags.group_name is free text with no "groups" row behind it,
// so a group "merge" is a bulk UPDATE of that column and nothing in the
// database ties the translated labels to it. Move them deliberately or they
// are orphaned behind a name no tag carries any more, and the group
// silently goes back to displaying untranslated.
//
// Tool merges: a tool is referenced twice over — by recipe_tools AND by an
// id inside each step's tool_ids array. A merge that fixed only the first
// would leave steps pointing at a tombstoned row.
//
// Technique merges: no join table at all, only recipe_steps.technique_ids,
// so the whole operation is an array rewrite — which makes the dedupe the
// thing worth pinning down, since a step can already list both sides.
// ═════════════════════════════════════════════════════════════════════════
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
        query: async (sql: string, params: unknown[] = []) => ({
          values: db.prepare(sql).all(...(params as never[])),
        }),
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

vi.mock('../lib/standalone', () => ({ getStandaloneProfile: async () => ({ name: 'Matteo' }) }));

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  vi.resetModules();
});

async function seedTags() {
  const { query } = await import('../db/local');
  await query(
    "INSERT INTO tags (id, name, group_name, exclude_tag_ids, synonyms) VALUES ($1,$2,$3,'[]','[]')",
    ['tag-sweet', 'Dolce', 'Sapore'],
  );
  await query(
    "INSERT INTO tags (id, name, group_name, exclude_tag_ids, synonyms) VALUES ($1,$2,$3,'[]','[]')",
    ['tag-salty', 'Salato', 'Sapore'],
  );
  await query(
    "INSERT INTO tags (id, name, group_name, exclude_tag_ids, synonyms) VALUES ($1,$2,$3,'[]','[]')",
    ['tag-veg', 'Vegetariano', 'Dieta'],
  );
}

describe('tag group labels', () => {
  it('stores and reads back a label per language, keyed by the group name', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTags();
    const { setTagGroupTranslations, listTagGroupTranslations } = await import('./tags.local');

    await setTagGroupTranslations('Sapore', [
      { lang: 'en', name: 'Flavour' },
      { lang: 'fr', name: 'Saveur' },
      // Dropped rather than stored blank: an empty label would render as an
      // empty heading, which is worse than falling back to the raw name.
      { lang: 'es', name: '  ' },
    ]);

    const all = await listTagGroupTranslations();
    expect(all['Sapore']).toEqual([
      { lang: 'en', name: 'Flavour' },
      { lang: 'fr', name: 'Saveur' },
    ]);
    expect(all['Dieta']).toBeUndefined();
  });

  it('replaces the whole set for a group rather than merging into it', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTags();
    const { setTagGroupTranslations, listTagGroupTranslations } = await import('./tags.local');

    await setTagGroupTranslations('Sapore', [{ lang: 'en', name: 'Flavour' }, { lang: 'fr', name: 'Saveur' }]);
    await setTagGroupTranslations('Sapore', [{ lang: 'en', name: 'Taste' }]);

    expect((await listTagGroupTranslations())['Sapore']).toEqual([{ lang: 'en', name: 'Taste' }]);
  });

  it('carries the labels across when the group is renamed', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTags();
    const { setTagGroupTranslations, listTagGroupTranslations, mergeTagGroups } = await import('./tags.local');

    await setTagGroupTranslations('Sapore', [{ lang: 'en', name: 'Flavour' }]);
    const { tagsUpdated } = await mergeTagGroups('Sapore', 'Gusto');

    expect(tagsUpdated).toBe(2);
    const all = await listTagGroupTranslations();
    expect(all['Gusto']).toEqual([{ lang: 'en', name: 'Flavour' }]);
    expect(all['Sapore']).toBeUndefined();
  });

  it('keeps the target group’s own label when two groups are merged', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTags();
    const { setTagGroupTranslations, listTagGroupTranslations, mergeTagGroups } = await import('./tags.local');

    await setTagGroupTranslations('Sapore', [{ lang: 'en', name: 'Flavour' }, { lang: 'fr', name: 'Saveur' }]);
    await setTagGroupTranslations('Dieta', [{ lang: 'en', name: 'Diet' }]);

    await mergeTagGroups('Sapore', 'Dieta');

    const merged = await listTagGroupTranslations();
    // English: both had one, the target's survives. French: only the source
    // had one, so it comes across rather than being thrown away.
    expect(merged['Dieta']).toEqual([{ lang: 'en', name: 'Diet' }, { lang: 'fr', name: 'Saveur' }]);
    expect(merged['Sapore']).toBeUndefined();
  });

  it('serves the labels through the local router, not a server', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTags();
    const { dispatchLocal } = await import('./localRouter');

    const saved = await dispatchLocal('/api/tags/groups/translations', {
      method: 'PUT',
      body: JSON.stringify({ groupName: 'Sapore', translations: [{ lang: 'en', name: 'Flavour' }] }),
    });
    expect(saved?.status).toBe(200);

    const read = await dispatchLocal('/api/tags/groups/translations', { method: 'GET' });
    expect(read?.status).toBe(200);
    expect((read?.data as Record<string, unknown>)['Sapore']).toEqual([{ lang: 'en', name: 'Flavour' }]);
  });
});

describe('merging a kitchen tool', () => {
  async function seedTools() {
    const { query } = await import('../db/local');
    const { createRecipe } = await import('./recipes.local');
    for (const [id, name] of [['tool-pan', 'Padella'], ['tool-skillet', 'Padella antiaderente']]) {
      await query(
        "INSERT INTO tools (id, name, image_urls, synonyms) VALUES ($1,$2,'[]','[]')",
        [id, name],
      );
    }
    await createRecipe({
      id: 'recipe-a',
      title: 'Frittata',
      servings: 2,
      ingredients: [],
      // The duplicate is referenced BOTH ways a tool can be: on the recipe
      // and inside one of its steps. A merge that only fixed the first
      // would leave the step pointing at a tombstoned row.
      toolIds: ['tool-skillet'],
      steps: [{ stepNumber: 1, description: 'Sbattere le uova.', toolIds: ['tool-skillet'] }],
    } as never, 'Matteo');
    await createRecipe({
      id: 'recipe-b',
      title: 'Saltato di verdure',
      servings: 2,
      ingredients: [],
      // Already carries both, so the union must not trip recipe_tools' own
      // (recipe_id, tool_id) primary key.
      toolIds: ['tool-pan', 'tool-skillet'],
      steps: [{ stepNumber: 1, description: 'Scaldare la padella.', toolIds: [] }],
    } as never, 'Matteo');
  }

  it('repoints every recipe and every step, then tombstones the duplicate', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTools();
    const { mergeTools, listTools } = await import('./ingredients.local');
    const { query } = await import('../db/local');

    const { recipesUpdated } = await mergeTools('tool-skillet', 'tool-pan');
    expect(recipesUpdated).toBe(2);

    const links = await query<{ recipe_id: string; tool_id: string }>('SELECT recipe_id, tool_id FROM recipe_tools ORDER BY recipe_id');
    expect(links).toEqual([
      { recipe_id: 'recipe-a', tool_id: 'tool-pan' },
      { recipe_id: 'recipe-b', tool_id: 'tool-pan' },
    ]);

    const steps = await query<{ tool_ids: string }>("SELECT tool_ids FROM recipe_steps WHERE recipe_id='recipe-a'");
    expect(JSON.parse(steps[0].tool_ids)).toEqual(['tool-pan']);

    // Soft-deleted, not dropped: the tombstone is what carries the deletion
    // to other devices through folder sync (see deleteTool()'s own note).
    // listTools() spreads a Record<string, unknown> row, so `name` is there
    // at runtime but not in the inferred type.
    const names = (await listTools({})).map((t) => (t as unknown as { name: string }).name);
    expect(names).toEqual(['Padella']);
    const [source] = await query<{ deleted_at: string | null }>("SELECT deleted_at FROM tools WHERE id='tool-skillet'");
    expect(source.deleted_at).not.toBeNull();
  });

  it('refuses to merge a tool into itself', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTools();
    const { mergeTools } = await import('./ingredients.local');
    await expect(mergeTools('tool-pan', 'tool-pan')).rejects.toThrow(/itself/i);
  });

  it('is reachable through the local router', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTools();
    const { dispatchLocal } = await import('./localRouter');

    const res = await dispatchLocal('/api/tools/tool-skillet/merge', {
      method: 'POST',
      body: JSON.stringify({ targetId: 'tool-pan' }),
    });
    expect(res?.status).toBe(200);
    expect((res?.data as { recipesUpdated: number }).recipesUpdated).toBe(2);
  });
});

describe('merging a cooking technique', () => {
  async function seedTechniques() {
    const { query } = await import('../db/local');
    const { createRecipe } = await import('./recipes.local');
    // The duplicate pair the catalogue actually collects: Smart Import
    // creates a technique per parsed step name, so an Italian recipe leaves
    // "Bollitura" sitting next to the "Boil" an English one created.
    for (const [id, name] of [['tech-boil', 'Boil'], ['tech-bollitura', 'Bollitura']]) {
      await query(
        "INSERT INTO techniques (id, name, image_urls, synonyms) VALUES ($1,$2,'[]','[]')",
        [id, name],
      );
    }
    await createRecipe({
      id: 'recipe-pasta',
      title: 'Pasta',
      servings: 2,
      ingredients: [],
      steps: [
        { stepNumber: 1, description: 'Porta a bollore.', toolIds: [], techniqueIds: ['tech-bollitura'] },
        { stepNumber: 2, description: 'Scola.', toolIds: [], techniqueIds: [] },
      ],
    } as never, 'Matteo');
    await createRecipe({
      id: 'recipe-eggs',
      title: 'Uova sode',
      servings: 2,
      ingredients: [],
      // Already lists BOTH, so the rewrite must dedupe rather than leave the
      // target twice in the same step.
      steps: [{ stepNumber: 1, description: 'Cuoci le uova.', toolIds: [], techniqueIds: ['tech-boil', 'tech-bollitura'] }],
    } as never, 'Matteo');
  }

  it('repoints every step and tombstones the duplicate', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTechniques();
    const { mergeTechniques, listTechniques } = await import('./techniques.local');
    const { query } = await import('../db/local');

    const { recipesUpdated } = await mergeTechniques('tech-bollitura', 'tech-boil');
    expect(recipesUpdated).toBe(2);

    const steps = await query<{ recipe_id: string; step_number: number; technique_ids: string }>(
      'SELECT recipe_id, step_number, technique_ids FROM recipe_steps ORDER BY recipe_id, step_number',
    );
    expect(steps.map((st) => JSON.parse(st.technique_ids))).toEqual([
      ['tech-boil'], // was both, deduped to one
      ['tech-boil'], // was the duplicate, repointed
      [],            // untouched
    ]);

    const names = (await listTechniques({})).map((t) => (t as unknown as { name: string }).name);
    expect(names).toEqual(['Boil']);
    const [source] = await query<{ deleted_at: string | null }>("SELECT deleted_at FROM techniques WHERE id='tech-bollitura'");
    expect(source.deleted_at).not.toBeNull();
  });

  it('refuses to merge a technique into itself', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTechniques();
    const { mergeTechniques } = await import('./techniques.local');
    await expect(mergeTechniques('tech-boil', 'tech-boil')).rejects.toThrow(/itself/i);
  });

  it('is reachable through the local router', async () => {
    await (await import('../db/local')).initLocalSchema();
    await seedTechniques();
    const { dispatchLocal } = await import('./localRouter');

    const res = await dispatchLocal('/api/techniques/tech-bollitura/merge', {
      method: 'POST',
      body: JSON.stringify({ targetId: 'tech-boil' }),
    });
    expect(res?.status).toBe(200);
    expect((res?.data as { recipesUpdated: number }).recipesUpdated).toBe(2);
  });
});
