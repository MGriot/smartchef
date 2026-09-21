import { describe, it, expect } from 'vitest';
import { healEntitySides, healToolIdsValue, toolNamesFromSides } from './referenceHeal';
import { fieldValuesEqual } from '../mergeNormalize';

// The real shape of the bug: the phone and Windows each created "Frusta"
// before tools had portable ids, so each minted its own crypto.randomUUID().
const PHONE_ID = '9d2f41aa6b1c4e6f8a0d3b77c5e21f04';
const WINDOWS_ID = '1b7c05de3f8a42d19c6e8f240ab35d17';

describe('toolNamesFromSides', () => {
  it('pools the sidecars from every side', () => {
    const names = toolNamesFromSides(
      { [PHONE_ID]: 'Frusta' },
      { [WINDOWS_ID]: 'Frusta', 'tool-pentola': 'Pentola' },
      undefined,
    );
    expect(names.get(PHONE_ID)).toBe('Frusta');
    expect(names.get(WINDOWS_ID)).toBe('Frusta');
    expect(names.get('tool-pentola')).toBe('Pentola');
  });

  it('accepts a JSON string and ignores anything malformed', () => {
    const names = toolNamesFromSides(JSON.stringify({ 'tool-x': 'X' }), '{', ['not', 'an', 'object'], null, 7);
    expect([...names]).toEqual([['tool-x', 'X']]);
  });

  it('skips blank names rather than mapping an id to nothing', () => {
    expect(toolNamesFromSides({ 'tool-a': '', 'tool-b': '   ', 'tool-c': 'C' }).size).toBe(1);
  });
});

describe('healToolIdsValue', () => {
  const names = new Map([[PHONE_ID, 'Frusta'], [WINDOWS_ID, 'Frusta']]);

  it('folds two ids naming the same tool onto one, chosen identically on both devices', () => {
    // No portable id on either side, so the rule is "lexicographically
    // smallest" — which both devices compute from the same pooled map and
    // therefore agree on without talking to each other.
    const [canonical, loser] = [PHONE_ID, WINDOWS_ID].sort();
    expect(healToolIdsValue([loser], names)).toEqual([canonical]);
    // The side already holding the canonical id needs no rewrite, and says
    // so with null rather than handing back an equal copy.
    expect(healToolIdsValue([canonical], names)).toBeNull();
  });

  it('prefers a portable id over a random one when any side has upgraded', () => {
    const mixed = new Map([[PHONE_ID, 'Frusta'], ['tool-frusta', 'Frusta']]);
    expect(healToolIdsValue([PHONE_ID], mixed)).toEqual(['tool-frusta']);
  });

  it('collapses a union that already carries both ids', () => {
    // This is what mergeSetField() produces with no common base, and what
    // made the conflict reappear after every resolution.
    const canonical = [PHONE_ID, WINDOWS_ID].sort()[0];
    expect(healToolIdsValue([PHONE_ID, WINDOWS_ID], names)).toEqual([canonical]);
  });

  it('leaves an id no side can name alone — unknown is not wrong', () => {
    expect(healToolIdsValue(['tool-nobody-knows'], names)).toBeNull();
  });

  it('returns null when nothing needed healing, so a caller can tell', () => {
    expect(healToolIdsValue(['tool-frusta'], new Map([['tool-frusta', 'Frusta']]))).toBeNull();
    expect(healToolIdsValue([PHONE_ID], new Map())).toBeNull();
  });

  it('ignores a malformed value instead of throwing mid-merge', () => {
    expect(healToolIdsValue('{', names)).toBeNull();
    expect(healToolIdsValue({ not: 'an array' }, names)).toBeNull();
    expect(healToolIdsValue(null, names)).toBeNull();
  });
});

describe('healEntitySides — tools', () => {
  it('makes two sides that disagree only about tool ids compare equal', () => {
    const local = { toolIds: [PHONE_ID], toolNames: { [PHONE_ID]: 'Frusta' } };
    const remote = { toolIds: [WINDOWS_ID], toolNames: { [WINDOWS_ID]: 'Frusta' } };

    const healed = healEntitySides('recipe', {}, local, remote);

    // Exactly one side moves — whichever is not already holding the
    // canonical id — and that side is flagged so its own rows get
    // rewritten and the healed value is what gets republished.
    expect([...healed.localHealed, ...healed.remoteHealed]).toEqual(['toolIds']);
    // The whole point: mergeSetField() would have unioned these into two
    // tools and recorded a conflict. After healing there is nothing to
    // disagree about, so no conflict is generated at all.
    expect(fieldValuesEqual('toolIds', healed.local.toolIds, healed.remote.toolIds)).toBe(true);
  });

  it('keeps the representation the value arrived in', () => {
    const local = { toolIds: JSON.stringify([PHONE_ID]), toolNames: { [PHONE_ID]: 'Frusta' } };
    const remote = { toolIds: [WINDOWS_ID], toolNames: { [WINDOWS_ID]: 'Frusta' } };

    const healed = healEntitySides('recipe', {}, local, remote);

    expect(typeof healed.local.toolIds).toBe('string');
    expect(Array.isArray(healed.remote.toolIds)).toBe(true);
  });

  it('reports nothing healed when both sides already agree', () => {
    const side = { toolIds: ['tool-frusta'], toolNames: { 'tool-frusta': 'Frusta' } };
    const healed = healEntitySides('recipe', {}, { ...side }, { ...side });
    expect(healed.localHealed).not.toContain('toolIds');
    expect(healed.remoteHealed).not.toContain('toolIds');
  });

  it('does not disturb a recipe from a device that never sent toolNames', () => {
    // Mixed-version fleet: the sidecar is absent, so there is nothing to
    // heal with and the ids must travel untouched rather than being
    // guessed at.
    const local = { toolIds: [PHONE_ID] };
    const remote = { toolIds: [WINDOWS_ID] };
    const healed = healEntitySides('recipe', {}, local, remote);
    expect(healed.local.toolIds).toEqual([PHONE_ID]);
    expect(healed.remote.toolIds).toEqual([WINDOWS_ID]);
    expect(healed.localHealed).toEqual([]);
  });
});
