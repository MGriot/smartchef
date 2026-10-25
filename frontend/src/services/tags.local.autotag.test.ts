import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/local', () => ({ query: vi.fn(), queryOne: vi.fn(), chunk: vi.fn(), inPlaceholders: vi.fn() }));
vi.mock('./syncExtras.local', () => ({ freshPortableId: vi.fn(), portableTagId: vi.fn() }));

import { computeAutoTagNames } from './tags.local';
import type { LocalClient } from '../db/local';

const catalog = [
  { id: 'veg', name: 'Vegetariano', group_name: 'Dieta', exclude_tag_ids: '["meat"]' },
  { id: 'meat', name: 'Carne', group_name: 'Contiene', exclude_tag_ids: '[]' },
  { id: 'gluten', name: 'Glutine', group_name: 'Contiene', exclude_tag_ids: '[]' },
  { id: 'comfort', name: 'Comfort food', group_name: 'Altro', exclude_tag_ids: '[]' },
  { id: 'primo', name: 'Primo', group_name: 'Portata', exclude_tag_ids: '[]' },
];

function clientWith(presentIds: string[]): LocalClient {
  return {
    query: async (sql: string) => sql.includes('FROM recipe_ingredients')
      ? { rows: catalog.filter(t => presentIds.includes(t.id)).map(t => ({ id: t.id, name: t.name })) }
      : { rows: catalog },
  } as unknown as LocalClient;
}

describe('computeAutoTagNames', () => {
  it('passes on what an ingredient contains, and the diets that still fit', async () => {
    expect((await computeAutoTagNames(clientWith(['gluten']), 'r1')).sort()).toEqual(['Glutine', 'Vegetariano']);
    expect(await computeAutoTagNames(clientWith(['meat']), 'r1')).toEqual(['Carne']);
  });

  it('never passes on dish tags left on an ingredient', async () => {
    expect((await computeAutoTagNames(clientWith(['comfort', 'primo', 'gluten']), 'r1')).sort()).toEqual(['Glutine', 'Vegetariano']);
  });
});
