import { describe, expect, it } from 'vitest';
import { missingPreferences } from './prefsBackup';
import { isBrokenIndexError } from './sync/hiddenClone';

describe('missingPreferences', () => {
  const stored: Record<string, string> = { 'CapacitorStorage.kept': 'new' };
  const get = (key: string) => (key in stored ? stored[key] : null);

  it('returns only the keys the storage lost', () => {
    const lost = missingPreferences({ 'CapacitorStorage.kept': 'old', 'CapacitorStorage.token': 'abc' }, get);
    expect(lost).toEqual({ 'CapacitorStorage.token': 'abc' });
  });

  it('never overwrites a value that is present', () => {
    expect(missingPreferences({ 'CapacitorStorage.kept': 'old' }, get)).toEqual({});
  });

  it('ignores keys outside the preferences namespace and non-string values', () => {
    expect(missingPreferences({ other: 'x', 'CapacitorStorage.n': 3 as unknown as string }, get)).toEqual({});
  });
});

describe('isBrokenIndexError', () => {
  it('recognises the damaged index message', () => {
    expect(isBrokenIndexError(new Error('...error message: Index file is empty (.git/index)'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isBrokenIndexError(new Error('HTTP 401'))).toBe(false);
  });
});
