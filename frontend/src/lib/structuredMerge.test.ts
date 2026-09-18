import { describe, it, expect } from 'vitest';
import { mergeField, mergeEntity } from './structuredMerge';

describe('mergeField', () => {
  it('is unchanged when neither side differs from the ancestor', () => {
    expect(mergeField('Lasagna', 'Lasagna', 'Lasagna')).toEqual({ type: 'unchanged' });
  });

  it('fast-forwards to remote when only remote changed', () => {
    expect(mergeField('Lasagna', 'Lasagna', "Nonna's Lasagna")).toEqual({ type: 'fast-forward', value: "Nonna's Lasagna" });
  });

  it('keeps local when only local changed (no write needed)', () => {
    expect(mergeField('Lasagna', "Grandma's Lasagna", 'Lasagna')).toEqual({ type: 'keep-local' });
  });

  it('is unchanged when both sides independently converged on the same value', () => {
    expect(mergeField('Lasagna', 'Amazing Lasagna', 'Amazing Lasagna')).toEqual({ type: 'unchanged' });
  });

  it('is a conflict when both sides changed to different values', () => {
    expect(mergeField('Lasagna', "Grandma's Lasagna", "Nonna's Lasagna")).toEqual({
      type: 'conflict', base: 'Lasagna', local: "Grandma's Lasagna", remote: "Nonna's Lasagna",
    });
  });

  it('treats whole-array fields as opaque values, not per-element (ADR 0002) — any divergence is a conflict', () => {
    const base = ['Preheat oven', 'Bake'];
    const local = ['Preheat oven', 'Brown the beef', 'Bake']; // local added a step
    const remote = ['Preheat oven', 'Bake for 45 min']; // remote edited a different step
    expect(mergeField(base, local, remote)).toEqual({ type: 'conflict', base, local, remote });
  });

  it('fast-forwards a whole-array field when only remote touched it', () => {
    const base = ['a', 'b'];
    const remote = ['a', 'b', 'c'];
    expect(mergeField(base, base, remote)).toEqual({ type: 'fast-forward', value: remote });
  });

  it('is unchanged when two devices independently edit a whole-array field to the same result', () => {
    const base = ['Preheat oven', 'Bake'];
    const converged = ['Preheat oven', 'Brown the beef', 'Bake'];
    // local and remote are different array instances but deep-equal —
    // both devices happened to make the exact same edit independently.
    expect(mergeField(base, [...converged], [...converged])).toEqual({ type: 'unchanged' });
  });

  it('is unchanged for two nulls', () => {
    expect(mergeField(null, null, null)).toEqual({ type: 'unchanged' });
  });

  it('handles a field changing from null to a value on only one side', () => {
    expect(mergeField(null, null, 'now set')).toEqual({ type: 'fast-forward', value: 'now set' });
  });
});

describe('mergeEntity', () => {
  it('merges independent fields independently — a conflict on one field does not block others from fast-forwarding', () => {
    const base = { title: 'Lasagna', servings: 4, steps: ['a'] };
    const local = { title: "Grandma's Lasagna", servings: 4, steps: ['a', 'b'] };
    const remote = { title: "Nonna's Lasagna", servings: 6, steps: ['a'] };

    const result = mergeEntity(base, local, remote, ['title', 'servings', 'steps']);

    expect(result.applied).toEqual({ servings: 6 }); // only remote changed servings -> fast-forward
    expect(result.conflicts).toEqual([
      { fieldName: 'title', baseValue: 'Lasagna', localValue: "Grandma's Lasagna", remoteValue: "Nonna's Lasagna" },
    ]);
    // steps: only local changed -> keep-local, no entry in applied or conflicts
  });

  it('produces no conflicts and nothing to apply when nothing changed on either side', () => {
    const row = { title: 'Lasagna', servings: 4 };
    const result = mergeEntity(row, row, row, ['title', 'servings']);
    expect(result.applied).toEqual({});
    expect(result.conflicts).toEqual([]);
  });

  it('only considers the field names it is given, ignoring any other keys present on the objects', () => {
    const base = { title: 'A', internalOnly: 1 };
    const local = { title: 'A', internalOnly: 2 };
    const remote = { title: 'B', internalOnly: 3 };
    const result = mergeEntity(base, local, remote, ['title']);
    expect(result.applied).toEqual({ title: 'B' });
    expect(result.conflicts).toEqual([]);
  });
});

describe('mergeField — ADR 0006 rules', () => {
  const older = Date.UTC(2026, 8, 1);
  const newer = Date.UTC(2026, 8, 17);

  it('does not count serialization noise as an edit on either side', () => {
    const base = '["Vegano","Salsa"]';
    expect(mergeField(base, '["Salsa","Vegano"]', ['Vegano', 'Salsa'], { fieldName: 'tags' })).toEqual({ type: 'unchanged' });
    expect(mergeField(null, '', null, { fieldName: 'tips' })).toEqual({ type: 'unchanged' });
  });

  describe('with no common ancestor', () => {
    it('takes the other side when one side is empty, whichever side that is', () => {
      expect(mergeField(undefined, '', 'Consiglio', { fieldName: 'tips', hasBase: false, policy: 'ask' }))
        .toEqual({ type: 'auto-resolved', winner: 'remote', value: 'Consiglio', reason: 'empty-side' });
      expect(mergeField(undefined, 'Consiglio', null, { fieldName: 'tips', hasBase: false, policy: 'ask' }))
        .toEqual({ type: 'keep-local' });
    });

    it('asks when both have different content and the policy is ask', () => {
      expect(mergeField(undefined, 'Mine', 'Theirs', { fieldName: 'description', hasBase: false, policy: 'ask', localUpdatedAt: older, remoteUpdatedAt: newer }).type)
        .toBe('conflict');
    });

    it('keeps the newer side under the newest policy', () => {
      expect(mergeField(undefined, 'Mine', 'Theirs', { fieldName: 'description', hasBase: false, policy: 'newest', localUpdatedAt: older, remoteUpdatedAt: newer }))
        .toEqual({ type: 'auto-resolved', winner: 'remote', value: 'Theirs', reason: 'newest' });
    });
  });

  it('newest policy: local wins when local is newer', () => {
    expect(mergeField('Base', 'Mine', 'Theirs', { fieldName: 'title', policy: 'newest', localUpdatedAt: newer, remoteUpdatedAt: older }))
      .toEqual({ type: 'auto-resolved', winner: 'local', value: 'Mine', reason: 'newest' });
  });

  it('newest policy still asks when the timestamps cannot tell', () => {
    expect(mergeField('Base', 'Mine', 'Theirs', { fieldName: 'title', policy: 'newest', localUpdatedAt: older, remoteUpdatedAt: older }).type).toBe('conflict');
    expect(mergeField('Base', 'Mine', 'Theirs', { fieldName: 'title', policy: 'newest' }).type).toBe('conflict');
  });

  it('merges a set field member by member instead of conflicting', () => {
    const result = mergeField('["a","b"]', '["a","b","c"]', '["a","d"]', { fieldName: 'tags', policy: 'ask' });
    expect(result.type).toBe('merged');
    expect(JSON.parse((result as { value: string }).value)).toEqual(['a', 'c', 'd']);
  });

  it('a set merge that equals one side is just that side', () => {
    expect(mergeField('["a"]', '["a","b"]', '["a"]', { fieldName: 'tags' })).toEqual({ type: 'keep-local' });
  });
});

describe('mergeEntity — ADR 0006', () => {
  it('reads updated_at from each side for the newest policy and reports what it settled', () => {
    const base = { title: 'Lasagna', tips: 'old' };
    const local = { title: 'Lasagna mine', tips: 'old', updated_at: '2026-09-01 10:00:00' };
    const remote = { title: 'Lasagna theirs', tips: 'new tip', updated_at: '2026-09-17 10:00:00' };
    const result = mergeEntity(base, local, remote, ['title', 'tips'], { policy: 'newest' });
    expect(result.applied).toEqual({ title: 'Lasagna theirs', tips: 'new tip' });
    expect(result.conflicts).toEqual([]);
    expect(result.autoResolved).toEqual([{ fieldName: 'title', winner: 'remote', reason: 'newest' }]);
  });

  it('with no ancestor, fills gaps both ways and only conflicts on real differences', () => {
    const local = { description: '', tips: 'mine', steps: [{ id: 'a', step_number: 1, description: 'Mix' }] };
    const remote = { description: 'Theirs', tips: 'theirs', steps: [{ id: 'b', step_number: 1, description: 'Mix' }] };
    const result = mergeEntity({}, local, remote, ['description', 'tips', 'steps'], { hasBase: false, policy: 'ask' });
    expect(result.applied).toEqual({ description: 'Theirs' });
    expect(result.conflicts.map((c) => c.fieldName)).toEqual(['tips']);
  });
});
