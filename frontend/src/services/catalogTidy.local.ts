// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Tidy with AI" for tools, techniques, units and seasonality
// (standalone mode)
//
// The ingredient catalog has its own, richer pass (aiTasks.local.ts
// tidyIngredients). This is the same idea for the other libraries:
//   - tools: English name, a name per language, description, group,
//     synonyms
//   - techniques: the same without the group
//   - units: name and a name per language (never the symbol — a unit's
//     portable id is derived from it, and recipes point at that id)
//   - seasonality: the months each ingredient is in season in a region
// The model sees each row as it is today and corrects as well as fills.
// What comes back is a suggestion: lib/catalogTidy.ts turns it into the
// reviewable changes, and applyCatalogTidy() writes only the ticked ones.
// ════════════════════════════════════════════════════════════════════════

import { callConfiguredProvider, parseJsonObject } from './llmParser.local';
import { languageLabel } from '../lib/languages';
import { query, queryOne } from '../db/local';

const newId = (): string => crypto.randomUUID();

export type CatalogTidyKind = 'tools' | 'techniques' | 'units';

export interface CatalogTidyAspects {
  naming: boolean;
  description: boolean;
  category: boolean;
  synonyms: boolean;
}

export interface CatalogTidyInput {
  key: string;
  text: string;
  symbol?: string | null;
  known?: Record<string, string>;
  description?: string | null;
  category?: string | null;
  synonyms?: string[];
}

export interface CatalogTidyResult {
  key: string;
  name?: string;
  translations?: Array<{ lang: string; text: string }>;
  wrongTranslations?: string[];
  description?: string | null;
  descriptionWrong?: boolean;
  category?: string | null;
  synonyms?: string[];
}

export interface CatalogTidyContext {
  kind: CatalogTidyKind;
  aspects: CatalogTidyAspects;
  langs: string[];
  /** Every name already in this catalog, so the model reuses one instead of
   *  coining a near-duplicate. */
  catalogNames: string[];
  /** Tools only: the groups already in use. */
  categoryNames?: string[];
}

const CATALOG_NOUN: Record<CatalogTidyKind, string> = {
  tools: 'kitchen tool and equipment catalog (pans, knives, appliances, utensils)',
  techniques: 'cooking technique catalog (boiling, braising, julienne, emulsifying)',
  units: 'measurement unit catalog (gram, cup, tablespoon, pinch)',
};

const stringList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()) : [];

export function buildCatalogTidyPrompt(ctx: CatalogTidyContext): string {
  const { aspects, kind } = ctx;
  const langList = ctx.langs.map((l) => `"${l}" (${languageLabel(l, 'en')})`).join(', ');
  const sections: string[] = [
    `You maintain the ${CATALOG_NOUN[kind]} of a recipe app. Each input item is one catalog row as it is today: ` +
    `"text" is its base name${kind === 'units' ? ', "symbol" its abbreviation (never change it)' : ''}` +
    `${aspects.naming ? ', "known" its name per language' : ''}` +
    `${aspects.description && kind !== 'units' ? ', "description" its short description (null = none)' : ''}` +
    `${aspects.category && kind === 'tools' ? ', "category" the group it is filed under' : ''}` +
    `${aspects.synonyms && kind !== 'units' ? ', "synonyms" its other names' : ''}. ` +
    `Values on file can be WRONG as well as missing: correct them, do not just copy them back.`,
  ];
  if (aspects.naming) {
    sections.push(
      `"name": the catalog base name — English, Title Case, singular` +
      `${kind === 'techniques' ? ', the technique as a noun or gerund ("Braising", "Julienne", "Blind Baking")' : ''}` +
      `${kind === 'units' ? ' ("Gram", "Tablespoon", "Pinch")' : ''}` +
      `, no brands. If "text" is not English or not well formed, give the correct English name. If a catalog name ` +
      `below means the same thing, reuse it EXACTLY.\n` +
      `"translations": its natural name in each of ${langList}, as a cook would write it, first letter capitalized.\n` +
      `"wrongTranslations": the language codes whose "known" name is WRONG — it names a different thing, is in the ` +
      `wrong language, or is a mistranslation. A merely different but correct wording is NOT wrong. Empty array if none.`,
    );
  }
  if (aspects.description && kind !== 'units') {
    sections.push(
      `"description": one or two plain English sentences a home cook finds useful — ` +
      `${kind === 'techniques' ? 'what the technique does and when to use it' : 'what it is and what it is used for'}. ` +
      `If the row already has a good description, return it unchanged. "descriptionWrong": true ONLY when the ` +
      `description on file describes something else or is factually wrong; false otherwise.`,
    );
  }
  if (aspects.category && kind === 'tools') {
    sections.push(
      `"category": the group this tool belongs in. Prefer a group already in use, copied EXACTLY: ` +
      `${ctx.categoryNames?.length ? ctx.categoryNames.map((c) => `"${c}"`).join(', ') : '(none yet)'}; ` +
      `only when none fits, a short new English group in Title Case ("Cookware", "Knives", "Appliances", ` +
      `"Utensils", "Bakeware", "Measuring"). Keep the row's group when it is right.`,
    );
  }
  if (aspects.synonyms && kind !== 'units') {
    sections.push(
      `"synonyms": other names people use for this same thing, in English or the languages above (regional names, ` +
      `other spellings). Not the name itself, not brands. At most 5. Empty array if none.`,
    );
  }
  const shape = [
    '"key": "..."',
    ...(aspects.naming ? ['"name": "..."', '"translations": {...}', '"wrongTranslations": [...]'] : []),
    ...(aspects.description && kind !== 'units' ? ['"description": "..."', '"descriptionWrong": false'] : []),
    ...(aspects.category && kind === 'tools' ? ['"category": "..."'] : []),
    ...(aspects.synonyms && kind !== 'units' ? ['"synonyms": [...]'] : []),
  ].join(', ');
  sections.push(`Respond EXCLUSIVELY with JSON: {"items": [{${shape}}]}, one entry per input item, keys copied exactly.`);
  if (aspects.naming && ctx.catalogNames.length) sections.push(`Names ALREADY in this catalog:\n${ctx.catalogNames.join(', ')}`);
  return sections.join('\n\n');
}

/** Field by field: anything malformed is dropped rather than failing the
 *  batch, and an aspect that was not asked for is never returned. */
export function normalizeCatalogTidy(parsed: any, items: CatalogTidyInput[], ctx: CatalogTidyContext): CatalogTidyResult[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const rows: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
  const out: CatalogTidyResult[] = [];
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !byKey.has(row.key)) continue;
    const source = byKey.get(row.key)!;
    const result: CatalogTidyResult = { key: row.key };
    if (ctx.aspects.naming) {
      result.name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : source.text.trim();
      const raw = row.translations && typeof row.translations === 'object' ? row.translations : {};
      result.translations = ctx.langs
        .filter((lang) => typeof raw[lang] === 'string' && raw[lang].trim())
        .map((lang) => ({ lang, text: raw[lang].trim() }));
      const have = new Set(result.translations.map((t) => t.lang));
      result.wrongTranslations = stringList(row.wrongTranslations).map((l) => l.toLowerCase()).filter((l) => have.has(l));
    }
    if (ctx.aspects.description && ctx.kind !== 'units') {
      // Two sentences, not an article: it lands in a one-line list cell.
      const d = typeof row.description === 'string' ? row.description.trim() : '';
      result.description = d && d.length <= 400 ? d : null;
      result.descriptionWrong = row.descriptionWrong === true;
    }
    if (ctx.aspects.category && ctx.kind === 'tools') {
      const c = typeof row.category === 'string' ? row.category.trim() : '';
      const existing = (ctx.categoryNames ?? []).find((n) => n.toLowerCase() === c.toLowerCase());
      result.category = c && c.length <= 40 ? existing ?? c : null;
    }
    if (ctx.aspects.synonyms && ctx.kind !== 'units') {
      const base = (result.name ?? source.text).toLowerCase();
      result.synonyms = [...new Set(stringList(row.synonyms))].filter((s) => s.toLowerCase() !== base).slice(0, 5);
    }
    out.push(result);
    byKey.delete(row.key);
  }
  return out;
}

const TABLES: Record<CatalogTidyKind, { table: string; translations: string; fk: string; liveWhere: string }> = {
  tools: { table: 'tools', translations: 'tool_translations', fk: 'tool_id', liveWhere: 'deleted_at IS NULL' },
  techniques: { table: 'techniques', translations: 'technique_translations', fk: 'technique_id', liveWhere: 'deleted_at IS NULL' },
  units: { table: 'units', translations: 'unit_translations', fk: 'unit_id', liveWhere: '1=1' },
};

async function libraryLangs(): Promise<string[]> {
  const { listLanguages } = await import('../lib/languages');
  // The base name IS the English name, so English is never asked for.
  return [...new Set(listLanguages().map((l) => l.code))].filter((code) => code !== 'en');
}

/** One request per batch; the Library sends a batch at a time so progress
 *  moves and a refused batch costs only itself. */
export async function suggestCatalogTidy(kind: CatalogTidyKind, items: CatalogTidyInput[], aspects: CatalogTidyAspects): Promise<CatalogTidyResult[]> {
  const clean = items.filter((i) => i && typeof i.key === 'string' && typeof i.text === 'string' && i.text.trim());
  if (clean.length === 0) return [];
  const t = TABLES[kind];
  const names = await query<{ name: string; category?: string | null }>(
    `SELECT name${kind === 'tools' ? ', category' : ''} FROM ${t.table} WHERE ${t.liveWhere} ORDER BY name`,
  );
  const ctx: CatalogTidyContext = {
    kind,
    aspects,
    langs: await libraryLangs(),
    catalogNames: names.map((n) => n.name),
    categoryNames: kind === 'tools' ? [...new Set(names.map((n) => (n.category ?? '').trim()).filter(Boolean))] : undefined,
  };
  const systemPrompt = buildCatalogTidyPrompt(ctx);
  const payload = clean.map((b) => ({
    key: b.key,
    text: b.text,
    ...(kind === 'units' && b.symbol ? { symbol: b.symbol } : {}),
    ...(aspects.naming && b.known && Object.keys(b.known).length ? { known: b.known } : {}),
    ...(aspects.description && kind !== 'units' ? { description: b.description ?? null } : {}),
    ...(aspects.category && kind === 'tools' ? { category: b.category ?? null } : {}),
    ...(aspects.synonyms && kind !== 'units' ? { synonyms: b.synonyms ?? [] } : {}),
  }));
  const raw = await callConfiguredProvider(JSON.stringify({ items: payload }), systemPrompt, undefined, { maxTokens: 8192 });
  return normalizeCatalogTidy(parseJsonObject(raw), clean, ctx);
}

export interface CatalogTidyChange {
  name?: string;
  translations?: Array<{ lang: string; text: string }>;
  description?: string;
  category?: string;
  addSynonyms?: string[];
}

/** Writes only what the change carries — unlike the edit form's PUT, which
 *  rewrites every column (and every translation) from a full form. */
export async function applyCatalogTidy(kind: CatalogTidyKind, id: string, change: CatalogTidyChange): Promise<void> {
  const t = TABLES[kind];
  const row = await queryOne<{ id: string }>(`SELECT id FROM ${t.table} WHERE id=$1 AND ${t.liveWhere}`, [id]);
  if (!row) return;
  const touch = kind === 'units' ? '' : ', updated_at=now()';
  if (typeof change.name === 'string' && change.name.trim()) {
    await query(`UPDATE ${t.table} SET name=$1${touch} WHERE id=$2`, [change.name.trim(), id]);
  }
  if (kind !== 'units' && typeof change.description === 'string' && change.description.trim()) {
    await query(`UPDATE ${t.table} SET description=$1${touch} WHERE id=$2`, [change.description.trim(), id]);
  }
  if (kind === 'tools' && typeof change.category === 'string' && change.category.trim()) {
    await query(`UPDATE tools SET category=$1, updated_at=now() WHERE id=$2`, [change.category.trim(), id]);
  }
  for (const tr of change.translations ?? []) {
    const lang = tr?.lang?.trim().toLowerCase();
    const text = tr?.text?.trim();
    if (!lang || !text) continue;
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM ${t.translations} WHERE ${t.fk}=$1 AND LOWER(language_code)=$2`, [id, lang],
    );
    if (existing) await query(`UPDATE ${t.translations} SET name=$1 WHERE id=$2`, [text, existing.id]);
    else await query(`INSERT INTO ${t.translations} (id, ${t.fk}, language_code, name) VALUES ($1, $2, $3, $4)`, [newId(), id, lang, text]);
  }
  if (kind !== 'units' && change.addSynonyms?.length) {
    const current = await queryOne<{ synonyms: string | null }>(`SELECT synonyms FROM ${t.table} WHERE id=$1`, [id]);
    let list: string[] = [];
    try { list = JSON.parse(current?.synonyms ?? '[]'); } catch { list = []; }
    const seen = new Set(list.map((s) => s.toLowerCase()));
    for (const s of change.addSynonyms) {
      const clean = typeof s === 'string' ? s.trim() : '';
      if (clean && !seen.has(clean.toLowerCase())) { list.push(clean); seen.add(clean.toLowerCase()); }
    }
    await query(`UPDATE ${t.table} SET synonyms=$1${touch} WHERE id=$2`, [JSON.stringify(list), id]);
  }
  if (kind === 'tools') await (await import('./ingredients.local')).syncTool(id);
  else if (kind === 'techniques') await (await import('./techniques.local')).syncTechnique(id);
  else await (await import('./ingredients.local')).syncUnit(id);
}

// ── Seasonality ─────────────────────────────────────────────────────────
// Only fresh produce and seasonal catches have a season; a pantry staple
// answers an empty list, which the review offers as "clear" (never
// pre-selected) for a row that has months on file.

export interface SeasonInput { key: string; text: string; months?: number[] }
export interface SeasonResult { key: string; months: number[] }

export function buildSeasonalityPrompt(region: string): string {
  return (
    `You know the produce calendar of ${region}. Each input item is an ingredient from a recipe app: "text" is its ` +
    `English name, "months" the months it is recorded as in season today (1 = January … 12 = December; may be ` +
    `missing or WRONG). For each item give "months": the months it is in season locally in ${region} — fresh ` +
    `fruit, vegetables, herbs, mushrooms, nuts, and fish or game with a real season. For anything available the same ` +
    `all year or not seasonal (flour, oil, spices, dairy, meat, dried or processed goods, imported tropical fruit ` +
    `with no local season) give an empty array. Correct months on file that are wrong.\n\n` +
    `Respond EXCLUSIVELY with JSON: {"items": [{"key": "...", "months": [..]}]}, one entry per input item, keys copied exactly.`
  );
}

export function normalizeSeasonality(parsed: any, items: SeasonInput[]): SeasonResult[] {
  const keys = new Set(items.map((i) => i.key));
  const rows: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
  const out: SeasonResult[] = [];
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !keys.has(row.key) || !Array.isArray(row.months)) continue;
    const months = [...new Set<number>(row.months.map((m: unknown) => Number(m)).filter((m: number) => Number.isInteger(m) && m >= 1 && m <= 12))];
    out.push({ key: row.key, months: months.sort((a, b) => a - b) });
    keys.delete(row.key);
  }
  return out;
}

export async function suggestSeasonality(items: SeasonInput[], region: string): Promise<SeasonResult[]> {
  const clean = items.filter((i) => i && typeof i.key === 'string' && typeof i.text === 'string' && i.text.trim());
  if (clean.length === 0) return [];
  const payload = clean.map((b) => ({ key: b.key, text: b.text, ...(b.months?.length ? { months: b.months } : {}) }));
  const raw = await callConfiguredProvider(JSON.stringify({ items: payload }), buildSeasonalityPrompt(region || 'Italy'), undefined, { maxTokens: 8192 });
  return normalizeSeasonality(parseJsonObject(raw), clean);
}

/** Sets an ingredient's season, leaving every other column alone. */
export async function applySeasonality(id: string, months: number[]): Promise<void> {
  const clean = [...new Set(months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
  await query("UPDATE ingredients SET seasonal_months=$1, updated_at=now() WHERE id=$2 AND sync_status != 'deleted'", [JSON.stringify(clean), id]);
  await (await import('./ingredients.local')).syncIngredient(id);
}
