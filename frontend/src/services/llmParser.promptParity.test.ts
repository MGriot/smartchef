// ════════════════════════════════════════════════════════════════════════
// The recipe-import prompt exists twice — backend/src/services/llm.parser.ts
// for server mode and frontend/src/services/llmParser.local.ts for
// standalone — and both files say in their own headers that the copies must
// not drift. Nothing enforced that, and the two had already drifted by one
// character ("->" against "→") before anyone noticed.
//
// This reads both files off disk and compares the marked blocks byte for
// byte. It is also the only automated protection the backend copy gets at
// all: backend/package.json has no test script, so a frontend test reaching
// across the repo is the whole safety net (same precedent as
// ingredients.local.list.integration.test.ts).
//
// If this fails: you edited one prompt and not the other. Copy the block
// across verbatim — do not "fix" it by loosening the comparison.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');

const BACKEND = resolve(REPO, 'backend/src/services/llm.parser.ts');
const STANDALONE = resolve(REPO, 'frontend/src/services/llmParser.local.ts');

/** Everything between a BEGIN/END marker pair, markers included.
 *
 *  Line endings are normalised first. The two files are checked out with
 *  different ones on Windows (the backend copy has CRLF, the frontend copy
 *  LF), which made this comparison fail on every line while the prompts
 *  themselves were identical — and a test that is always red is a test
 *  nobody reads. It is not a loosening: a template literal normalises CR
 *  and CRLF to LF per the language spec, so the string the model actually
 *  receives is the same either way, which is exactly what this is for. */
function twinBlock(file: string, label: string): string {
  const source = readFileSync(file, 'utf8').split('\r\n').join('\n');
  const begin = source.indexOf(`BEGIN TWIN BLOCK: ${label}`);
  const end = source.indexOf(`END TWIN BLOCK: ${label}`);
  expect(begin, `${file} is missing the "${label}" BEGIN marker`).toBeGreaterThan(-1);
  expect(end, `${file} is missing the "${label}" END marker`).toBeGreaterThan(begin);
  return source.slice(begin, end);
}

describe('recipe-import prompt parity between server and standalone mode', () => {
  it('keeps the base prompt byte-identical', () => {
    expect(twinBlock(STANDALONE, 'base prompt')).toBe(twinBlock(BACKEND, 'base prompt'));
  });

  // The catalog block is prompt AND the logic that renders it (the
  // per-provider tiering, the "Base (Traduzione)" form, the validation of
  // what comes back). All of it has to behave the same in both modes, so
  // all of it is compared.
  it('keeps the catalog prompt and its rendering byte-identical', () => {
    expect(twinBlock(STANDALONE, 'catalog prompt')).toBe(twinBlock(BACKEND, 'catalog prompt'));
  });

  // Guards against the markers being present but empty, which would make
  // the comparisons above pass without comparing anything.
  it('is actually comparing the prompt, not two empty strings', () => {
    const base = twinBlock(BACKEND, 'base prompt');
    expect(base).toContain('Sei un assistente specializzato');
    expect(base.length).toBeGreaterThan(3000);

    const catalog = twinBlock(BACKEND, 'catalog prompt');
    expect(catalog).toContain('Catalogo della libreria');
    expect(catalog).toContain('CATALOG_INGREDIENTS_PROVIDERS');
  });
});
