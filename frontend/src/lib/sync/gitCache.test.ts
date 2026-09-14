// ════════════════════════════════════════════════════════════════════════
// The shared object cache is easy to get subtly wrong in a way no feature
// test would notice: forget to pass it at one call site and that site
// silently falls back to isomorphic-git's per-call default, which is the
// behaviour this exists to remove. Nothing fails — it just gets slow again,
// and only on a device.
//
// So rather than testing the two-line module, these assert the thing that
// actually regresses: that every production isomorphic-git call on the
// read-heavy paths passes `cache`, and that the cache is dropped where the
// object store changes underneath it.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Every `git.<method>({...})` call in a file, as its raw argument text. */
function gitCalls(source: string): Array<{ method: string; args: string }> {
  const out: Array<{ method: string; args: string }> = [];
  const re = /\bgit\.(\w+)\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    // Walk to the matching brace so multi-line calls are captured whole.
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    out.push({ method: m[1], args: source.slice(re.lastIndex, i - 1) });
  }
  return out;
}

/** Calls that read or resolve objects — the ones a cold cache makes
 *  expensive. `init`, `clone` and `addRemote` are excluded: a clone
 *  populates the store rather than reading it repeatedly, and the probe
 *  deliberately throws its clone away afterwards. */
const OBJECT_READING = new Set([
  'readBlob', 'listFiles', 'findMergeBase', 'statusMatrix', 'log', 'add', 'readTree', 'walk',
]);

const FILES = [
  'lib/sync/mergeBridge.ts',
  'lib/sync/imageSync.ts',
  'lib/sync/gitSync.ts',
  'lib/sync/firstRunProbe.ts',
];

describe('every object-reading git call passes the shared cache', () => {
  for (const rel of FILES) {
    it(rel, () => {
      const source = read(rel);
      const missing = gitCalls(source)
        .filter((c) => OBJECT_READING.has(c.method))
        .filter((c) => !/\bcache\s*:/.test(c.args))
        .map((c) => c.method);

      // A miss here means that call re-reads and re-indexes the packfile
      // every time, which on Android is a whole-file base64 crossing of the
      // Capacitor bridge per object.
      expect(missing).toEqual([]);
    });
  }

  it('finds the calls at all, so a passing result means something', () => {
    // Guards against the regex silently matching nothing after a refactor,
    // which would make every assertion above vacuously true.
    const found = FILES.flatMap((rel) => gitCalls(read(rel))).filter((c) => OBJECT_READING.has(c.method));
    expect(found.length).toBeGreaterThanOrEqual(8);
  });
});

describe('the cache is dropped where it would go stale', () => {
  const gitSync = read('lib/sync/gitSync.ts');

  it('is reset around every packing run', () => {
    // gitPacking rewrites .git/objects/pack and prunes the loose objects it
    // absorbed, so an index cached from before it describes files that are
    // gone.
    const packCalls = gitSync.split('packLooseObjectsAfterPush(').length - 1;
    expect(packCalls).toBeGreaterThan(0);
    const resetsBeforePack = gitSync.split(/resetGitCache\(\);\s*(?:\/\/[^\n]*\n\s*)*await packLooseObjectsAfterPush\(/).length - 1;
    expect(resetsBeforePack).toBe(packCalls);
  });

  it('is reset at both ends of a sync cycle', () => {
    const cycle = gitSync.slice(gitSync.indexOf('export function syncNow('));
    const body = cycle.slice(0, cycle.indexOf("}, 'syncNow');"));
    expect(body.split('resetGitCache();').length - 1).toBe(2);
  });

  it('is reset after the first-run probe throws its clone away', () => {
    const probe = read('lib/sync/firstRunProbe.ts');
    const tail = probe.slice(probe.indexOf('} finally {'));
    expect(tail).toContain('removeRecursively(dir)');
    expect(tail).toContain('resetGitCache()');
  });
});
