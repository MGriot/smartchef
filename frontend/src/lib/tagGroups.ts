// ════════════════════════════════════════════════════════════════════════
// SmartChef — Tag group label translation
// tags.group_name is free-typed text (LibraryTags.tsx), not a real entity
// with its own translations table like every other translatable thing in
// this app — so the seeded default groups (see db/migrations/017_seed_tags.sql)
// are given a static i18n lookup here instead. Any group name the user
// types that isn't one of these (a custom group) just displays as-is,
// same as it always has.
// ════════════════════════════════════════════════════════════════════════

import type { TFunction } from 'i18next';

const KNOWN_GROUPS = new Set(['dieta', 'contiene', 'portata', 'altro']);

export function translateTagGroup(groupName: string, t: TFunction): string {
  const key = groupName.trim().toLowerCase();
  if (!KNOWN_GROUPS.has(key)) return groupName;
  return t(`tagGroups.${key}`, groupName);
}
