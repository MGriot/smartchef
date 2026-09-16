// ════════════════════════════════════════════════════════════════════════
// A desktop failed to push for a week and reported nothing, because sync
// health was gated behind a platform check in two places at once:
//
//   gitSync.ts       reportTransportOutcome()  →  if (isElectron()) return;
//   Account.tsx      refreshPauseReason()      →  if (electron) return;
//
// Both were justified by "Electron has no separate mirror step to pause",
// which was simply not true: the state is plain Preferences and the banner
// is ordinary markup, so both work identically on desktop. The guards were
// the only thing suppressing them.
//
// That is a property of the source, not of a return value — a unit test
// with a mocked isElectron() would pass just as happily with the guard
// reinstated somewhere new. So these read the files, the same approach
// gitCache.test.ts uses for its own cross-cutting invariant.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** The body of a named function, from its declaration to the line that
 *  closes it at the same indentation. */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`could not find ${declaration}`);
  const indent = ' '.repeat(start - source.lastIndexOf('\n', start) - 1);
  const end = source.indexOf(`\n${indent}}`, start);
  return source.slice(start, end < 0 ? undefined : end);
}

describe('a transport failure is reported on every platform', () => {
  it('reportTransportOutcome does not skip a platform', () => {
    const body = functionBody(read('lib/sync/gitSync.ts'), 'async function reportTransportOutcome(');

    expect(body).toContain('setSyncPauseReason');
    // The regression: one early return here is a week of silent failure.
    expect(body).not.toMatch(/isElectron\(\)/);
  });

  it('the Account screen loads sync health without a platform check', () => {
    const body = functionBody(read('pages/Account.tsx'), 'const refreshSyncHealth = async () => {');

    expect(body).toContain('getSyncPauseReason');
    expect(body).toContain('getLastPushAt');
    expect(body).not.toMatch(/if \(electron\)/);
  });

  it('finds those functions at all, so passing means something', () => {
    // Guards against a rename quietly making both assertions vacuous.
    expect(() => functionBody(read('lib/sync/gitSync.ts'), 'async function reportTransportOutcome(')).not.toThrow();
    expect(() => functionBody(read('pages/Account.tsx'), 'const refreshSyncHealth = async () => {')).not.toThrow();
  });
});

describe('a successful push is recorded', () => {
  const gitSync = read('lib/sync/gitSync.ts');

  it('is stamped on both sync modes, not just one', () => {
    // Folder mode and git-remote mode have separate push paths; recording
    // in only one would make the staleness warning lie on the other.
    expect(gitSync.split('recordSuccessfulPush()').length - 1).toBeGreaterThanOrEqual(3); // 2 calls + the definition
  });

  it('uses a key of its own rather than reusing the last-sync one', () => {
    // lastSyncAt advances whenever a cycle COMPLETES, including cycles that
    // fetched perfectly and pushed nothing — which is exactly the state
    // that hid the failure.
    expect(gitSync).toContain("'smartchef.sync.lastPushAt'");
    expect(gitSync).toContain('export async function getLastPushAt');
  });
});
