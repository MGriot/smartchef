// ════════════════════════════════════════════════════════════════════════
// Locale key parity.
//
// i18n/index.ts sets fallbackLng: "en", so a key missing from it/fr/es
// doesn't throw and doesn't render as the key name — it silently renders
// the ENGLISH string inside an otherwise translated UI. That failure mode
// is invisible in review and invisible at runtime unless you happen to be
// reading that screen in that language, which is how login.username,
// login.usernamePlaceholder and login.networkError sat in en.json alone.
//
// Adding a key to one file and forgetting the other three is the single
// easiest mistake to make in this codebase's i18n, so it gets a test.
// ════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
// Aliased away from their bare language codes because `it` would shadow
// vitest's own `it()`.
import enLocale from './locales/en.json';
import itLocale from './locales/it.json';
import frLocale from './locales/fr.json';
import esLocale from './locales/es.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? flatten(value as Tree, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );
}

const locales: Array<[string, Tree]> = [
  ['en', enLocale as Tree],
  ['it', itLocale as Tree],
  ['fr', frLocale as Tree],
  ['es', esLocale as Tree],
];

// en is the fallback language, so it defines the expected set.
const expected = flatten(enLocale as Tree).sort();

describe('locale files', () => {
  it.each(locales)('%s has exactly the same keys as en', (_name, tree) => {
    expect(flatten(tree).sort()).toEqual(expected);
  });

  it.each(locales)('%s has no blank values', (_name, tree) => {
    const blank = Object.entries(collect(tree)).filter(([, v]) => v.trim() === '');
    expect(blank.map(([k]) => k)).toEqual([]);
  });
});

function collect(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'object' && value !== null) Object.assign(out, collect(value as Tree, `${prefix}${key}.`));
    else out[`${prefix}${key}`] = value as string;
  }
  return out;
}
