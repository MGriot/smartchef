// ════════════════════════════════════════════════════════════════════════
// SmartChef — Tag group label translation
// tags.group_name is free-typed text (LibraryTags.tsx), not a real entity
// with its own translations table like every other translatable thing in
// this app — so it gets translated two ways, in this order:
//
//   1. Whatever the user typed into the group's own translations editor
//      (Library > Tags > the pencil next to a group heading), stored keyed
//      by the group's text — see db/migrations/041_tag_group_translations.sql.
//   2. Failing that, the static lookup below, which covers the groups
//      seeded by db/migrations/017_seed_tags.sql so a fresh install reads
//      correctly in every shipped language before anyone has typed
//      anything.
//
// A group name matching neither still displays as-is, same as it always
// has — but now that's a group nobody has translated yet rather than a
// group nobody CAN translate.
// ════════════════════════════════════════════════════════════════════════

import type { TFunction } from 'i18next';

const KNOWN_GROUPS = new Set(['dieta', 'contiene', 'portata', 'altro']);

export interface TagGroupTranslation { lang: string; name: string }
/** Keyed by the group's own text — the shape GET /tags/groups/translations
 *  returns. */
export type TagGroupTranslations = Record<string, TagGroupTranslation[]>;

/** Case-insensitive: the group heading is looked up by the same free text
 *  the tag row carries, and "Dieta"/"dieta" are the same group everywhere
 *  else (mergeTagGroups(), the datalist) only because nothing ever
 *  normalizes it. Matching loosely here means a translation typed against
 *  one casing still applies to the other. */
function findTranslation(
  translations: TagGroupTranslations | undefined,
  groupName: string,
  lang: string | null | undefined,
): string | null {
  if (!translations || !lang) return null;
  const groupKey = groupName.trim().toLowerCase();
  const entry = Object.entries(translations).find(([g]) => g.trim().toLowerCase() === groupKey);
  if (!entry) return null;
  const hit = entry[1].find((t) => t.lang.trim().toLowerCase() === lang.trim().toLowerCase());
  return hit?.name.trim() || null;
}

export function translateTagGroup(
  groupName: string,
  t: TFunction,
  translations?: TagGroupTranslations,
  lang?: string | null,
): string {
  const userLabel = findTranslation(translations, groupName, lang);
  if (userLabel) return userLabel;
  const key = groupName.trim().toLowerCase();
  if (!KNOWN_GROUPS.has(key)) return groupName;
  return t(`tagGroups.${key}`, groupName);
}
