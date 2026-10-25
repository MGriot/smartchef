import { describe, it, expect } from 'vitest';
import { ingredientTagFilter } from './tagScope';

const catalog = [
  { id: 'veg', group_name: 'Dieta', exclude_tag_ids: '["meat","fish"]' },
  { id: 'meat', group_name: 'Contiene', exclude_tag_ids: '[]' },
  { id: 'fish', group_name: 'Renamed group', exclude_tag_ids: [] },
  { id: 'gluten', group_name: 'Allergens', exclude_tag_ids: null },
  { id: 'comfort', group_name: 'Altro', exclude_tag_ids: '[]' },
  { id: 'primo', group_name: 'Portata', exclude_tag_ids: '[]' },
];

describe('ingredientTagFilter', () => {
  const isIngredientTag = ingredientTagFilter(catalog);

  it('keeps contains and diet tags, in any known group name', () => {
    expect(isIngredientTag(catalog[0])).toBe(true);
    expect(isIngredientTag(catalog[1])).toBe(true);
    expect(isIngredientTag(catalog[3])).toBe(true);
  });

  it('keeps a tag a diet excludes even after its group is renamed', () => {
    expect(isIngredientTag(catalog[2])).toBe(true);
  });

  it('drops dish tags', () => {
    expect(isIngredientTag(catalog[4])).toBe(false);
    expect(isIngredientTag(catalog[5])).toBe(false);
  });
});
