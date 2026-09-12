-- 041_tag_group_translations.sql
-- Translated labels for tag groups.
--
-- Every other translatable thing in this app is an entity with an id, and
-- its translations table points at that id. A tag group isn't one:
-- tags.group_name is free text typed straight into the tag dialog, with no
-- "groups" table behind it — which is why "merging" two groups
-- (POST /tags/groups/merge) is just a bulk rename of that column.
--
-- So this keys on the group's own text instead. The consequence to know
-- about: renaming a group has to carry these rows across by name, which is
-- what the groups/merge route now does — otherwise a rename would silently
-- orphan the translations behind the old label.
--
-- Until now the four seeded groups had a static i18n lookup in the frontend
-- (frontend/src/lib/tagGroups.ts) and any group the user typed themselves
-- displayed untranslated in every language. That lookup stays as the
-- fallback; rows here win over it.

CREATE TABLE IF NOT EXISTS tag_group_translations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_name    TEXT NOT NULL,
  language_code TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_name, language_code)
);

CREATE INDEX IF NOT EXISTS idx_tag_group_translations_group ON tag_group_translations(group_name);
