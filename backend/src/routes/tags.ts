// ════════════════════════════════════════════════════════════════════════
// SmartChef — Routes: Tag Catalog
// Stesso pattern di techniques/tools: riga base + traduzioni. `excludeTagIds`
// rende un tag "auto/dieta": non vuoto significa "applica automaticamente
// questo tag a meno che la ricetta non contenga uno di questi altri tag"
// (calcolato in tags.service.ts a partire dagli ingredient_tags).
// ════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from "express";
import { query, queryOne } from "../db/pool";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

export const tagsRouter = Router();

/** '' is a real answer here — the ungrouped bucket — and has to survive
 *  being saved. `groupName || 'Altro'` used to turn every blank into the
 *  catch-all group, which meant "no group" was not a state a tag could be
 *  in at all, so POST /tags/groups/delete would have nowhere to put the
 *  tags it dissolves. An ABSENT groupName still falls back to 'Altro'. */
const resolveGroupName = (groupName: string | undefined | null): string =>
  groupName === undefined || groupName === null ? "Altro" : groupName.trim();

// GET /tags
tagsRouter.get("/", async (req: Request, res: Response) => {
  const { lang, q } = req.query;
  const params: unknown[] = [];
  if (lang) params.push(lang);
  if (q) params.push(`%${q}%`);
  const rows = await query(
    `SELECT t.*, ${lang ? "tt.name" : "NULL"} AS translated_name,
            COALESCE(
              (SELECT json_agg(json_build_object('lang', tr.language_code, 'name', tr.name))
               FROM tag_translations tr WHERE tr.tag_id = t.id),
              '[]'::json
            ) AS translations
     FROM tags t
     ${lang ? "LEFT JOIN tag_translations tt ON tt.tag_id = t.id AND LOWER(tt.language_code) = LOWER($1)" : ""}
     WHERE t.deleted_at IS NULL
       ${q ? `AND (t.name ILIKE $${params.length} OR EXISTS (SELECT 1 FROM unnest(t.synonyms) syn WHERE syn ILIKE $${params.length}))` : ""}
     ORDER BY t.sort_order, t.name`,
    params
  );
  res.json({ data: rows });
});

const TagSchema = z.object({
  name: z.string().min(1),
  groupName: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  excludeTagIds: z.array(z.string().uuid()).optional(),
  synonyms: z.array(z.string()).optional(),
  translations: z.array(z.object({
    lang: z.string(),
    name: z.string().optional(),
  })).optional(),
});

async function upsertTagTranslations(tagId: string, translations?: Array<{ lang: string; name?: string }>) {
  if (!translations) return;
  await query("DELETE FROM tag_translations WHERE tag_id=$1", [tagId]);
  for (const t of translations) {
    if (!t.lang || !t.name) continue;
    await query(
      `INSERT INTO tag_translations (tag_id, language_code, name) VALUES ($1, $2, $3)`,
      [tagId, t.lang, t.name]
    );
  }
}

tagsRouter.post("/", async (req: Request, res: Response) => {
  const parsed = TagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  const id = uuidv4();
  await query(
    `INSERT INTO tags (id, name, group_name, color, icon, exclude_tag_ids, synonyms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, d.name, resolveGroupName(d.groupName), d.color || null, d.icon || null, d.excludeTagIds || [], d.synonyms ?? []]
  );
  await upsertTagTranslations(id, d.translations);
  res.json({ data: { id } });
});

// GET /tags/custom — free-text recipe tags (recipes.tags is a plain
// TEXT[], not tag ids) that don't match any managed catalog tag by name.
// Lets Library > Tags surface what's actually in use but never got added
// to the catalog, so it can be either formally added or merged into an
// existing catalog tag — see POST /tags/custom/merge below.
tagsRouter.get("/custom", async (_req: Request, res: Response) => {
  const catalogRows = await query<{ name: string }>("SELECT name FROM tags WHERE deleted_at IS NULL");
  const catalogNames = new Set(catalogRows.map((t) => t.name.toLowerCase()));
  const recipeRows = await query<{ tags: string[] }>("SELECT tags FROM recipes WHERE sync_status != 'deleted'");
  const counts = new Map<string, { name: string; count: number }>();
  for (const r of recipeRows) {
    for (const raw of r.tags ?? []) {
      const name = raw.trim();
      if (!name || catalogNames.has(name.toLowerCase())) continue;
      const key = name.toLowerCase();
      const existing = counts.get(key);
      if (existing) existing.count++;
      else counts.set(key, { name, count: 1 });
    }
  }
  const data = Array.from(counts.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  res.json({ data });
});

/** Rewrites every recipe carrying `oldName` (case-insensitive) to carry
 *  `newName` instead, deduping if the recipe already had both. Shared by
 *  POST /tags/custom/merge (a free-text tag folded into a catalog tag) and
 *  POST /tags/:id/merge (two catalog tags folded together) — either way,
 *  recipes.tags only ever stores plain names, never ids. */
async function replaceTagNameInRecipes(oldName: string, newName: string): Promise<number> {
  const key = oldName.trim().toLowerCase();
  const recipeRows = await query<{ id: string; tags: string[] }>("SELECT id, tags FROM recipes WHERE sync_status != 'deleted'");
  let recipesUpdated = 0;
  for (const r of recipeRows) {
    const rowTags = r.tags ?? [];
    if (!rowTags.some((t) => t.trim().toLowerCase() === key)) continue;
    const merged = new Map<string, string>();
    for (const t of rowTags) {
      const trimmed = t.trim().toLowerCase() === key ? newName : t.trim();
      if (!trimmed) continue;
      merged.set(trimmed.toLowerCase(), trimmed);
    }
    await query("UPDATE recipes SET tags=$1, updated_at=now() WHERE id=$2", [Array.from(merged.values()), r.id]);
    recipesUpdated++;
  }
  return recipesUpdated;
}

const MergeCustomTagSchema = z.object({ name: z.string().min(1), targetTagId: z.string().uuid() });

// POST /tags/custom/merge — rewrites every recipe carrying `name`
// (case-insensitive) to carry the target catalog tag's canonical name
// instead. Free-text equivalent of ingredients merge (POST
// /ingredients/:id/merge) — there's no catalog row to fold since a custom
// tag was never in the catalog to begin with, just recipes' own tags arrays.
tagsRouter.post("/custom/merge", async (req: Request, res: Response) => {
  const parsed = MergeCustomTagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { name, targetTagId } = parsed.data;

  const target = await queryOne<{ name: string }>("SELECT name FROM tags WHERE id=$1 AND deleted_at IS NULL", [targetTagId]);
  if (!target) return res.status(404).json({ error: "Target tag not found" });

  const recipesUpdated = await replaceTagNameInRecipes(name, target.name);
  res.json({ data: { recipesUpdated } });
});

// ── Tag group labels ────────────────────────────────────────────────────
// A tag group is not an entity: tags.group_name is free text with no
// "groups" table behind it, so its translations are keyed by that text.
// See db/migrations/041_tag_group_translations.sql for the whole story,
// and frontend/src/lib/tagGroups.ts for the static fallback that still
// covers the four seeded groups in languages nobody has filled in here.

// GET /tags/groups/translations — every group's labels at once, keyed by
// group name. The tags page renders a heading per group, so per-group
// requests would be one round trip per heading for a handful of rows.
tagsRouter.get("/groups/translations", async (_req: Request, res: Response) => {
  const rows = await query<{ group_name: string; language_code: string; name: string }>(
    "SELECT group_name, language_code, name FROM tag_group_translations ORDER BY group_name, language_code"
  );
  const data: Record<string, Array<{ lang: string; name: string }>> = {};
  for (const row of rows) {
    (data[row.group_name] ||= []).push({ lang: row.language_code, name: row.name });
  }
  res.json({ data });
});

// PUT /tags/groups/translations — replaces the whole set for one group,
// same semantics as every other translations upsert in this file.
const TagGroupTranslationsSchema = z.object({
  groupName: z.string().min(1),
  translations: z.array(z.object({ lang: z.string(), name: z.string().optional() })).default([]),
});
tagsRouter.put("/groups/translations", async (req: Request, res: Response) => {
  const parsed = TagGroupTranslationsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const groupName = parsed.data.groupName.trim();
  if (!groupName) return res.status(400).json({ error: "A group name is required" });

  await query("DELETE FROM tag_group_translations WHERE group_name=$1", [groupName]);
  const saved: Array<{ lang: string; name: string }> = [];
  for (const t of parsed.data.translations) {
    const lang = t.lang?.trim();
    const name = t.name?.trim();
    if (!lang || !name) continue;
    await query(
      "INSERT INTO tag_group_translations (group_name, language_code, name) VALUES ($1, $2, $3)",
      [groupName, lang, name]
    );
    saved.push({ lang, name });
  }
  res.json({ data: { groupName, translations: saved } });
});

const MergeTagGroupsSchema = z.object({ sourceGroup: z.string().min(1), targetGroup: z.string().min(1) });

// POST /tags/groups/merge — group_name is free text with no separate
// "groups" table, so "merging" two groups is just a bulk rename of that
// column across whichever tags carried the old name. Registered before
// POST /tags/:id/merge below — Express would otherwise match this path's
// literal "groups" segment as that route's :id param.
tagsRouter.post("/groups/merge", async (req: Request, res: Response) => {
  const parsed = MergeTagGroupsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { sourceGroup, targetGroup } = parsed.data;
  const result = await query(
    "UPDATE tags SET group_name=$1, updated_at=now() WHERE group_name=$2 AND deleted_at IS NULL RETURNING id",
    [targetGroup, sourceGroup]
  );
  // The group's translated labels are keyed by this same free text, so
  // they travel with the rename or they end up stranded behind a label no
  // tag carries any more. Where both groups already have a label for a
  // language the target's wins — a merge picks a side, same as everywhere.
  if (sourceGroup !== targetGroup) {
    await query(
      `DELETE FROM tag_group_translations s
        WHERE s.group_name=$1
          AND EXISTS (SELECT 1 FROM tag_group_translations t
                       WHERE t.group_name=$2 AND LOWER(t.language_code)=LOWER(s.language_code))`,
      [sourceGroup, targetGroup]
    );
    await query(
      "UPDATE tag_group_translations SET group_name=$1, updated_at=now() WHERE group_name=$2",
      [targetGroup, sourceGroup]
    );
  }
  res.json({ data: { tagsUpdated: result.length } });
});

// POST /tags/groups/delete — dissolves a group without deleting anything
// that was in it: every tag filed under it becomes ungrouped (group_name
// ''), and the group's own translated labels go with it, since they are
// keyed by that same free text. Registered before POST /tags/:id/merge
// for the same reason groups/merge above is.
const DeleteTagGroupSchema = z.object({ groupName: z.string().min(1) });
tagsRouter.post("/groups/delete", async (req: Request, res: Response) => {
  const parsed = DeleteTagGroupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const groupName = parsed.data.groupName.trim();
  const result = await query(
    "UPDATE tags SET group_name='', updated_at=now() WHERE group_name=$1 AND deleted_at IS NULL RETURNING id",
    [groupName]
  );
  await query("DELETE FROM tag_group_translations WHERE group_name=$1", [groupName]);
  res.json({ data: { tagsUngrouped: result.length } });
});

// POST /tags/:id/merge — folds a mistakenly-duplicated catalog tag into
// another one: every recipe carrying it (by name), every ingredient
// tagged with it, and every other tag's excludeTagIds (the diet auto-tag
// exclusion list) referencing it are all repointed to the target, then
// the source is tombstoned. Mirrors POST /ingredients/:id/merge.
const MergeTagSchema = z.object({ targetId: z.string().uuid() });
tagsRouter.post("/:id/merge", async (req: Request, res: Response) => {
  const { id: sourceId } = req.params;
  const parsed = MergeTagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { targetId } = parsed.data;
  if (sourceId === targetId) return res.status(400).json({ error: "Cannot merge a tag into itself" });

  const source = await queryOne<{ name: string }>("SELECT name FROM tags WHERE id=$1", [sourceId]);
  const target = await queryOne<{ name: string }>("SELECT name FROM tags WHERE id=$1", [targetId]);
  if (!source || !target) return res.status(404).json({ error: "Tag not found" });

  await query(
    "INSERT INTO ingredient_tags (ingredient_id, tag_id) SELECT ingredient_id, $1 FROM ingredient_tags WHERE tag_id=$2 ON CONFLICT DO NOTHING",
    [targetId, sourceId]
  );
  await query("DELETE FROM ingredient_tags WHERE tag_id=$1", [sourceId]);

  for (const row of await query<{ id: string; exclude_tag_ids: string[] }>(
    "SELECT id, exclude_tag_ids FROM tags WHERE $1 = ANY(exclude_tag_ids)", [sourceId]
  )) {
    const replaced = Array.from(new Set(row.exclude_tag_ids.map((tid) => (tid === sourceId ? targetId : tid))));
    await query("UPDATE tags SET exclude_tag_ids=$1 WHERE id=$2", [replaced, row.id]);
  }

  const recipesUpdated = await replaceTagNameInRecipes(source.name, target.name);
  await query("UPDATE tags SET deleted_at=now(), updated_at=now() WHERE id=$1", [sourceId]);
  res.json({ data: { recipesUpdated } });
});

tagsRouter.put("/:id", async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = TagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  await query(
    `UPDATE tags SET name=$1, group_name=$2, color=$3, icon=$4, exclude_tag_ids=$5, synonyms=$6, updated_at=now()
     WHERE id=$7`,
    [d.name, resolveGroupName(d.groupName), d.color || null, d.icon || null, d.excludeTagIds || [], d.synonyms ?? [], id]
  );
  await upsertTagTranslations(id, d.translations);
  res.json({ success: true });
});

/** Strips `name` (case-insensitive) out of every recipe's tags array —
 *  used both when a catalog tag is deleted (below) and when a free-text
 *  custom tag is deleted directly (POST /tags/custom/delete). */
async function removeTagNameFromRecipes(name: string): Promise<number> {
  const key = name.trim().toLowerCase();
  const recipeRows = await query<{ id: string; tags: string[] }>("SELECT id, tags FROM recipes WHERE sync_status != 'deleted'");
  let recipesUpdated = 0;
  for (const r of recipeRows) {
    const rowTags = r.tags ?? [];
    if (!rowTags.some((t) => t.trim().toLowerCase() === key)) continue;
    const filtered = rowTags.filter((t) => t.trim().toLowerCase() !== key);
    await query("UPDATE recipes SET tags=$1, updated_at=now() WHERE id=$2", [filtered, r.id]);
    recipesUpdated++;
  }
  return recipesUpdated;
}

tagsRouter.delete("/:id", async (req: Request, res: Response) => {
  const tag = await queryOne<{ name: string }>("SELECT name FROM tags WHERE id=$1", [req.params.id]);
  await query("UPDATE tags SET deleted_at=now(), updated_at=now() WHERE id=$1", [req.params.id]);
  const recipesUpdated = tag ? await removeTagNameFromRecipes(tag.name) : 0;
  res.json({ data: { recipesUpdated } });
});

const DeleteCustomTagSchema = z.object({ name: z.string().min(1) });

// POST /tags/custom/delete — deletes a free-text custom tag (no catalog
// row to tombstone) by stripping it out of every recipe that carries it.
tagsRouter.post("/custom/delete", async (req: Request, res: Response) => {
  const parsed = DeleteCustomTagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const recipesUpdated = await removeTagNameFromRecipes(parsed.data.name);
  res.json({ data: { recipesUpdated } });
});
