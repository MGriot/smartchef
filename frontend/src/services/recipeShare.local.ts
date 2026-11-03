// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Send a copy": a recipe from one library into another
// (docs/plans/2026-11-01-sync-v2-change-log.md §5a)
//
// The share file is the recipe exactly as sync serializes it
// (buildRecipeEntity), with its sub-recipes, the ingredients, tools and
// techniques it uses, and its photos — so nothing about it is a second,
// drifting copy of the format: whatever sync carries, a share carries.
//
// Importing makes it the receiver's OWN recipe:
//   - new ids for the recipe and every row in it, so importing the same
//     file twice gives two recipes rather than one stealing the other's rows;
//   - ingredients, tools and techniques are matched to the receiver's
//     library by name — the name, a translation, a synonym or the plural,
//     compared after normalizing — and only created when nothing matches.
//     Exact matching only: a fuzzy guess would silently turn "Farina 0"
//     into "Farina di riso", and here there is no review step to catch it;
//   - every reference inside the steps' text ({{tool:…}}, {{tech:…}}) and
//     in their tool/technique lists is pointed at the receiver's ids;
//   - personal fields (rating, times cooked) start fresh, and the sender is
//     recorded as a source.
// Every row is written through the same createEntity() sync uses, then
// re-published, so the copy reaches the receiver's other devices.
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from '../db/local';
import { STEP_REF_RE, normalizeName } from '../lib/stepRefs';

export const SHARE_KIND = 'smartchef-share';
export const SHARE_VERSION = 1;

type Entity = Record<string, unknown>;

export interface ShareFile {
  kind: typeof SHARE_KIND;
  version: number;
  sharedAt: string;
  sharedBy?: string | null;
  /** The recipes the sender picked; `recipes` also holds their sub-recipes,
   *  children before parents. */
  rootRecipeIds: string[];
  recipes: Entity[];
  ingredients: Entity[];
  tools: Entity[];
  techniques: Entity[];
  /** images/<sha256>.<ext> → base64 */
  images: Record<string, string>;
}

export function isShareFile(value: unknown): value is ShareFile {
  const v = value as ShareFile;
  return !!v && v.kind === SHARE_KIND && Array.isArray(v.recipes) && Array.isArray(v.rootRecipeIds);
}

const parseIds = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Ids an entity's step texts reference with {{tool:…}} / {{tech:…}}. */
function refsIn(text: unknown, type: 'tool' | 'tech'): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(STEP_REF_RE)) if (m[1] === type) out.push(m[2].trim());
  return out;
}

const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// ── Sending ──────────────────────────────────────────────────────────────

/** The recipes and every sub-recipe they use, children first. */
async function recipeClosure(rootIds: string[]): Promise<string[]> {
  const order: string[] = [];
  const seen = new Set<string>();
  async function visit(id: string) {
    if (seen.has(id)) return;
    seen.add(id);
    const subs = await query<{ sub_recipe_id: string }>(
      `SELECT DISTINCT sub_recipe_id FROM recipe_ingredients WHERE recipe_id = $1 AND sub_recipe_id IS NOT NULL`, [id],
    );
    for (const s of subs) await visit(s.sub_recipe_id);
    order.push(id);
  }
  for (const id of rootIds) await visit(id);
  return order;
}

export async function buildShareFile(rootRecipeIds: string[], sharedBy?: string | null): Promise<ShareFile> {
  const [{ buildRecipeEntity }, { readExtraFields }, { defaultImageFs, isLocalImagePath }] = await Promise.all([
    import('./recipes.local'), import('./syncExtras.local'), import('../lib/localImages'),
  ]);
  const recipes: Entity[] = [];
  for (const id of await recipeClosure(rootRecipeIds)) {
    const entity = await buildRecipeEntity(id);
    if (entity && entity.sync_status !== 'deleted') recipes.push(entity);
  }

  const ingredientIds = new Set<string>();
  const toolIds = new Set<string>();
  const techniqueIds = new Set<string>();
  const imagePaths = new Set<string>();
  for (const r of recipes) {
    for (const row of (r.ingredients as Entity[]) ?? []) if (typeof row.ingredient_id === 'string') ingredientIds.add(row.ingredient_id);
    for (const id of parseIds(r.toolIds)) toolIds.add(id);
    if (typeof r.cover_image_url === 'string') imagePaths.add(r.cover_image_url);
    for (const s of (r.steps as Entity[]) ?? []) {
      for (const id of [...parseIds(s.tool_ids), ...refsIn(s.description, 'tool')]) toolIds.add(id);
      for (const id of [...parseIds(s.technique_ids), ...refsIn(s.description, 'tech')]) techniqueIds.add(id);
      if (typeof s.image_url === 'string') imagePaths.add(s.image_url);
    }
  }

  const ingredients: Entity[] = [];
  const queue = [...ingredientIds];
  while (queue.length) {
    const id = queue.shift()!;
    const row = await queryOne<Entity>(
      `SELECT i.*, c.name AS category_name FROM ingredients i LEFT JOIN ingredient_categories c ON c.id = i.category_id WHERE i.id = $1`, [id],
    );
    if (!row) continue;
    ingredients.push({ ...row, ...(await readExtraFields('ingredient', id, row)) });
    // A variety travels with its base ingredient, so it lands under it.
    if (typeof row.parent_ingredient_id === 'string' && !ingredientIds.has(row.parent_ingredient_id)) {
      ingredientIds.add(row.parent_ingredient_id);
      queue.push(row.parent_ingredient_id);
    }
  }
  const named = async (table: string, type: string, ids: Set<string>) => {
    const out: Entity[] = [];
    for (const id of ids) {
      const row = await queryOne<Entity>(`SELECT * FROM ${table} WHERE id = $1`, [id]);
      if (row) out.push({ ...row, ...(await readExtraFields(type, id, row)) });
    }
    return out;
  };

  const images: Record<string, string> = {};
  const fs = defaultImageFs();
  for (const path of imagePaths) {
    if (!isLocalImagePath(path)) continue; // a web link travels as the link
    try {
      images[path] = toBase64(await fs.readFile(path));
    } catch {
      // a photo this device no longer has: the recipe still goes
    }
  }

  return {
    kind: SHARE_KIND, version: SHARE_VERSION, sharedAt: new Date().toISOString(), sharedBy: sharedBy ?? null,
    rootRecipeIds: rootRecipeIds.filter((id) => recipes.some((r) => r.id === id)),
    recipes, ingredients, tools: await named('tools', 'tool', toolIds), techniques: await named('techniques', 'technique', techniqueIds), images,
  };
}

// ── Receiving ────────────────────────────────────────────────────────────

export interface ShareImportReport {
  /** The new recipes, the picked ones first. */
  recipes: Array<{ id: string; title: string }>;
  matched: { ingredients: number; tools: number; techniques: number };
  created: { ingredients: number; tools: number; techniques: number };
  /** Each shared ingredient/tool/technique by name, and whether it was new
   *  here — what the import screen lists. */
  items: { ingredients: ShareItem[]; tools: ShareItem[]; techniques: ShareItem[] };
  images: number;
}

export interface ShareItem { name: string; isNew: boolean }

/** Every normalized name a row of `table` answers to → its id. */
async function nameIndex(kind: 'ingredient' | 'tool' | 'technique'): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const add = (name: unknown, id: string) => {
    if (typeof name !== 'string') return;
    const key = normalizeName(name);
    if (key && !index.has(key)) index.set(key, id);
  };
  if (kind === 'ingredient') {
    for (const r of await query<Entity>(`SELECT id, name, plural_name, synonyms FROM ingredients WHERE sync_status != 'deleted'`)) {
      add(r.name, r.id as string); add(r.plural_name, r.id as string); parseIds(r.synonyms).forEach((s) => add(s, r.id as string));
    }
    for (const r of await query<Entity>(`SELECT ingredient_id, translated_name, plural_translation FROM ingredient_translations`)) {
      add(r.translated_name, r.ingredient_id as string); add(r.plural_translation, r.ingredient_id as string);
    }
  } else {
    const table = kind === 'tool' ? 'tools' : 'techniques';
    for (const r of await query<Entity>(`SELECT id, name, synonyms FROM ${table} WHERE deleted_at IS NULL`)) {
      add(r.name, r.id as string); parseIds(r.synonyms).forEach((s) => add(s, r.id as string));
    }
    const fk = kind === 'tool' ? 'tool_id' : 'technique_id';
    for (const r of await query<Entity>(`SELECT ${fk} AS owner, name FROM ${table.slice(0, -1)}_translations`)) add(r.name, r.owner as string);
  }
  return index;
}

/** The receiver's id for each shared entity: matched by any of its names,
 *  or created. */
async function resolveEntities(
  kind: 'ingredient' | 'tool' | 'technique', shared: Entity[], newIdFor: (e: Entity) => Promise<string>,
  report: ShareImportReport, created: Array<[string, string]>, mapParent?: (e: Entity, ids: Map<string, string>) => Entity,
): Promise<Map<string, string>> {
  const { createEntity } = await import('./conflicts.local');
  const index = await nameIndex(kind);
  const ids = new Map<string, string>();
  const names = (e: Entity) => [
    e.name, e.plural_name, ...parseIds(e.synonyms),
    ...((Array.isArray(e.translations) ? e.translations : []) as Entity[]).flatMap((t) => [t.translated_name, t.name, t.plural_translation]),
  ].filter((n): n is string => typeof n === 'string' && !!n.trim());
  const key = kind === 'tool' ? 'tools' : kind === 'technique' ? 'techniques' : 'ingredients';
  // Bases before varieties, so a variety's parent already has its new id.
  const ordered = [...shared].sort((a, b) => Number(!!a.parent_ingredient_id) - Number(!!b.parent_ingredient_id));
  for (const e of ordered) {
    const hit = names(e).map((n) => index.get(normalizeName(n))).find((id): id is string => !!id);
    if (hit) {
      ids.set(e.id as string, hit);
      report.matched[key] += 1;
      report.items[key].push({ name: String(e.name ?? ''), isNew: false });
      continue;
    }
    const id = await newIdFor(e);
    const { id: _id, created_at: _c, updated_at: _u, tag_ids: _t, ...fields } = mapParent ? mapParent(e, ids) : e;
    await createEntity(kind, id, { ...fields, sync_status: 'local', ...(kind === 'ingredient' ? {} : { deleted_at: null }) });
    ids.set(e.id as string, id);
    names(e).forEach((n) => { const k = normalizeName(n); if (k && !index.has(k)) index.set(k, id); });
    report.created[key] += 1;
    report.items[key].push({ name: String(e.name ?? ''), isNew: true });
    created.push([kind, id]);
  }
  return ids;
}

export async function importShareFile(file: ShareFile): Promise<ShareImportReport> {
  if (!isShareFile(file)) throw new Error('This is not a SmartChef share file.');
  if (file.version > SHARE_VERSION) throw new Error('This recipe was shared from a newer version of SmartChef. Update the app to open it.');
  const [{ createEntity, resyncEntityToGit }, extras, { storeImage }] = await Promise.all([
    import('./conflicts.local'), import('./syncExtras.local'), import('../lib/localImages'),
  ]);
  const report: ShareImportReport = {
    recipes: [], matched: { ingredients: 0, tools: 0, techniques: 0 }, created: { ingredients: 0, tools: 0, techniques: 0 },
    items: { ingredients: [], tools: [], techniques: [] }, images: 0,
  };
  const created: Array<[string, string]> = [];

  // Photos first; a stored photo's path is its content hash, so it is the
  // same path here as on the sender's device.
  for (const [path, b64] of Object.entries(file.images ?? {})) {
    const ext = path.slice(path.lastIndexOf('.') + 1);
    const stored = await storeImage(fromBase64(b64), ext);
    if (stored === path) report.images += 1;
  }

  const portable = async (table: string, make: (n: string) => string, e: Entity) => extras.freshPortableId(table, make(String(e.name ?? 'item')));
  const toolIds = await resolveEntities('tool', file.tools ?? [], (e) => portable('tools', extras.portableToolId, e), report, created);
  const techIds = await resolveEntities('technique', file.techniques ?? [], (e) => portable('techniques', extras.portableTechniqueId, e), report, created);
  const ingIds = await resolveEntities('ingredient', file.ingredients ?? [], async () => crypto.randomUUID(), report, created,
    (e, ids) => ({
      ...e,
      parent_ingredient_id: typeof e.parent_ingredient_id === 'string' ? ids.get(e.parent_ingredient_id) ?? null : null,
      // Filed by category name, as sync does; one is required.
      category_name: typeof e.category_name === 'string' && e.category_name.trim() ? e.category_name : 'Uncategorized',
    }));

  const mapIds = (value: unknown, ids: Map<string, string>) => {
    const mapped = parseIds(value).map((id) => ids.get(id)).filter((id): id is string => !!id);
    return typeof value === 'string' ? JSON.stringify(mapped) : mapped;
  };
  const relink = (text: unknown) => String(text ?? '').replace(STEP_REF_RE, (whole, type: string, id: string, raw?: string) => {
    if (type === 'ing') return whole;
    const target = (type === 'tool' ? toolIds : techIds).get(id.trim());
    return target ? `{{${type}:${target}${raw !== undefined ? `|${raw}` : ''}}}` : whole;
  });

  const recipeIds = new Map<string, string>();
  const sender = file.sharedBy?.trim();
  for (const r of file.recipes) {
    const id = crypto.randomUUID();
    recipeIds.set(r.id as string, id);
    const ingredients = ((r.ingredients as Entity[]) ?? []).map((row) => ({
      ...row, id: crypto.randomUUID(), recipe_id: id,
      ingredient_id: typeof row.ingredient_id === 'string' ? ingIds.get(row.ingredient_id) ?? null : null,
      sub_recipe_id: typeof row.sub_recipe_id === 'string' ? recipeIds.get(row.sub_recipe_id) ?? null : null,
    }));
    const steps = ((r.steps as Entity[]) ?? []).map((s) => ({
      ...s, id: crypto.randomUUID(), recipe_id: id, description: relink(s.description),
      tool_ids: mapIds(s.tool_ids ?? '[]', toolIds), technique_ids: mapIds(s.technique_ids ?? '[]', techIds),
    }));
    const sources = [
      ...((typeof r.sources === 'string' ? JSON.parse(r.sources || '[]') : r.sources ?? []) as unknown[]),
      ...(sender ? [{ type: 'other', label: `Shared by ${sender}` }] : []),
    ];
    const { id: _id, created_at: _c, updated_at: _u, toolNames: _n, yield_unit_symbol: yieldSymbol, ...fields } = r;
    // Unit ids are per device: the yield's unit travels by its symbol.
    const yieldUnit = typeof yieldSymbol === 'string'
      ? await queryOne<{ id: string }>(`SELECT id FROM units WHERE symbol = $1 LIMIT 1`, [yieldSymbol])
      : null;
    const now = new Date().toISOString();
    await createEntity('recipe', id, {
      ...fields, yield_unit_id: yieldUnit?.id ?? null, sync_status: 'local', rating: null, times_cooked: 0, created_at: now, updated_at: now,
      sources: JSON.stringify(sources), ingredients, steps, toolIds: mapIds(r.toolIds, toolIds),
    });
    created.push(['recipe', id]);
  }
  for (const root of file.rootRecipeIds) {
    const id = recipeIds.get(root);
    const r = file.recipes.find((x) => x.id === root);
    if (id && r) report.recipes.push({ id, title: String(r.title ?? '') });
  }

  // Through the normal sync path, so the copy reaches this library's other
  // devices like any recipe made here.
  for (const [type, id] of created) await resyncEntityToGit(type, id).catch(() => {});
  return report;
}
