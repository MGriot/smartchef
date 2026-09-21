import { describe, it, expect } from 'vitest';
import { classifyRepairFailure, MAX_REPAIR_ATTEMPTS } from './syncReconcile.local';

// The loop this classification exists to break: gitSync.ts re-queues every
// failed entity into sync_repair, pullRepoIntoDatabase() retries the queue
// at the top of the next cycle, the retry fails identically, and the same
// red line is shown to the user after every single sync — for months, on
// the same handful of tools.

describe('classifyRepairFailure', () => {
  it('gives up on an error that describes the entity itself', () => {
    // These read the same on the hundredth attempt as on the first.
    expect(classifyRepairFailure('UNIQUE constraint failed: tools.name')).toBe('permanent');
    expect(classifyRepairFailure('NOT NULL constraint failed: recipes.title')).toBe('permanent');
    expect(classifyRepairFailure('no such column: frobnicate')).toBe('permanent');
    expect(classifyRepairFailure("createEntity: unknown entity type 'widget'")).toBe('permanent');
    expect(classifyRepairFailure("writeScalarField: 'x' is not a recognized scalar field on 'tool'")).toBe('permanent');
  });

  it('keeps retrying an error that a later cycle could genuinely fix', () => {
    // mergeBridge writes types in order, but a partial fetch does not —
    // the tool really may arrive next cycle.
    expect(classifyRepairFailure('FOREIGN KEY constraint failed')).toBe('transient');
    expect(classifyRepairFailure('database is locked')).toBe('transient');
    expect(classifyRepairFailure('NotFoundError: could not find blob')).toBe('transient');
  });

  it('treats anything it does not recognise as transient', () => {
    // Deliberately biased: being wrong this way costs one wasted retry per
    // cycle until the attempt ceiling. Being wrong the other way abandons
    // data the user can still see on their other device.
    expect(classifyRepairFailure('something nobody anticipated')).toBe('transient');
    expect(classifyRepairFailure('')).toBe('transient');
  });

  it('is case-insensitive, since the wording varies by platform', () => {
    // Android's SQLCipher and better-sqlite3 do not capitalise alike.
    expect(classifyRepairFailure('unique constraint failed: tools.name')).toBe('permanent');
    expect(classifyRepairFailure('Foreign Key Constraint Failed')).toBe('transient');
  });

  it('keeps an attempt ceiling as the backstop', () => {
    // The ceiling is what settles an entity even when the taxonomy above
    // misjudged it, so no misclassification can reinstate the loop.
    expect(MAX_REPAIR_ATTEMPTS).toBeGreaterThan(0);
    expect(MAX_REPAIR_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
