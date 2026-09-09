// ════════════════════════════════════════════════════════════════════════
// The icon font is subset to the icons the app names (see
// scripts/subset-material-symbols.py), which buys back 3.6 MB of every
// cold start. The cost of that trade is staleness: write a new icon into
// the JSX, don't regenerate, and it renders as the literal word
// "thermostat" instead of a thermostat.
//
// Regenerating needs Python and fontTools, which a build machine may not
// have. This check does not — it reads the committed manifest and the
// source, so the failure shows up here rather than on screen.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(entry) ? [path] : [];
  });
}

/** Icon names written directly as the child of a material-symbols span.
 *  Names held in constant tables and rendered through `{opt.icon}` are not
 *  matched here — the generator's own scan is broader — so this is a floor,
 *  not a census. */
function iconsInMarkup(): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /material-symbols-outlined[^<>]*>\s*([a-z][a-z0-9_]{1,40})\s*</g;
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      found.set(match[1], file.slice(SRC.length + 1).replace(/\\/g, '/'));
    }
  }
  return found;
}

describe('material symbols subset', () => {
  const manifest = new Set(
    readFileSync(join(SRC, 'fonts', 'icons.txt'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean),
  );

  it('covers every icon written into the markup', () => {
    const used = iconsInMarkup();
    // A sanity floor: if the regex ever stops matching, an empty set would
    // pass the real assertion silently.
    expect(used.size).toBeGreaterThan(50);

    const missing = [...used].filter(([name]) => !manifest.has(name));
    expect(
      missing.map(([name, file]) => `${name} (${file})`),
      'run `npm run icons:subset` to add these to the font',
    ).toEqual([]);
  });
});
