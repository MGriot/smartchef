// ════════════════════════════════════════════════════════════════════════
// SmartChef — Ingredient Matcher
// Mappa i nomi ingredienti estratti dall'LLM agli ingredienti nel DB,
// usando similarità stringa + fallback a creazione automatica
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from "../db/pool";
import { v4 as uuidv4 } from "uuid";
import type { LLMParseResult, UUID } from "@shared/types/index";

interface DBIngredient { id: UUID; name: string; category_id: UUID; plural_name: string | null; }
interface DBUnit       { id: UUID; symbol: string; name: string; }
interface DBTool       { id: UUID; name: string; }
interface DBTechnique  { id: UUID; name: string; }

// ── Fuzzy String Match ─────────────────────────────────────────────────

/** Normalizza stringa per confronto: lowercase, rimuovi accenti e spazi extra */
function normalize(s: string): string {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

/** Calcola similarità Levenshtein normalizzata (0–1) */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;

  const m = na.length, n = nb.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = na[i-1] === nb[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);

  return 1 - dp[m][n] / Math.max(m, n);
}

// ── Unit Matching ──────────────────────────────────────────────────────

const UNIT_ALIASES: Record<string, string[]> = {
  g: ["grammo","grammi","gr","g"],
  kg: ["chilogrammo","chilogrammi","kilo","kg"],
  ml: ["millilitro","millilitri","ml"],
  l: ["litro","litri","lt"],
  tbsp: ["cucchiaio","cucchiai","tbsp","cucchiaio da tavola"],
  tsp: ["cucchiaino","cucchiaini","tsp"],
  cup: ["tazza","tazze","cup"],
  pz: ["pezzo","pezzi","pz","n.","numero","unità"],
  "q.b.": ["quanto basta","qb","q.b.","a piacere","a gusto"],
};

export async function matchUnit(unitText?: string): Promise<UUID | null> {
  if (!unitText) return null;

  const norm = normalize(unitText);

  // Prova match diretto con alias
  for (const [symbol, aliases] of Object.entries(UNIT_ALIASES)) {
    if (aliases.some((a) => normalize(a) === norm || norm.includes(normalize(a)))) {
      const row = await queryOne<{ id: UUID }>(
        "SELECT id FROM units WHERE symbol=$1", [symbol]
      );
      if (row) return row.id;
    }
  }

  // Prova match diretto nel DB
  const dbUnit = await queryOne<{ id: UUID }>(
    "SELECT id FROM units WHERE LOWER(symbol)=LOWER($1) OR LOWER(name)=LOWER($1)",
    [unitText]
  );
  return dbUnit?.id ?? null;
}

// ── Ingredient Matching ────────────────────────────────────────────────

export interface MatchedIngredient {
  ingredientId: UUID;
  ingredientName: string;
  confidence: number; // 0–1
  isNew: boolean;     // true se creato automaticamente
  unitId?: UUID;
  quantity?: number;
  quantityText?: string;
  notes?: string;
  groupName?: string | null;
}

/** Highest of similarity(name, ing.name) and similarity(name, ing.plural_name)
 *  when a plural is on file — so "2 apples" matches canonical "apple" via
 *  its stored plural instead of relying on Levenshtein tolerance alone
 *  (which fails for longer/irregular plurals, e.g. "leaf"/"leaves"). */
function bestSimilarity(name: string, ing: { name: string; plural_name: string | null }): number {
  const base = similarity(name, ing.name);
  if (!ing.plural_name) return base;
  return Math.max(base, similarity(name, ing.plural_name));
}

/** Trova l'ingrediente più simile nel DB (soglia 0.7) */
async function findBestMatch(
  name: string,
  allIngredients: DBIngredient[]
): Promise<{ ingredient: DBIngredient; score: number } | null> {
  let best: { ingredient: DBIngredient; score: number } | null = null;

  for (const ing of allIngredients) {
    const score = bestSimilarity(name, ing);
    if (score > 0.7 && (!best || score > best.score)) {
      best = { ingredient: ing, score };
    }
  }

  return best;
}

/** Trova la categoria "Altro", creandola se non esiste ancora */
async function getOrCreateFallbackCategory(): Promise<UUID> {
  const existing = await queryOne<{ id: UUID }>(
    "SELECT id FROM ingredient_categories WHERE name='Altro' AND deleted_at IS NULL LIMIT 1"
  );
  if (existing) return existing.id;

  const id = uuidv4();
  await query(
    `INSERT INTO ingredient_categories (id, name) VALUES ($1, 'Altro')
     ON CONFLICT (name) WHERE deleted_at IS NULL DO NOTHING`,
    [id]
  );
  const row = await queryOne<{ id: UUID }>(
    "SELECT id FROM ingredient_categories WHERE name='Altro' AND deleted_at IS NULL LIMIT 1"
  );
  return row!.id;
}

/** Crea un nuovo ingrediente nel DB nella categoria "Altro". Il nome-base
 *  degli ingredienti è per convenzione in inglese (vedi il catalogo
 *  pre-seedato, dove ingredient_translations contiene solo traduzioni 'it'
 *  su nomi-base inglesi) — quando l'ingrediente viene creato durante
 *  l'import di una ricetta non-inglese, il chiamante traduce prima il nome
 *  e passa qui il nome inglese, salvando poi il nome originale come
 *  traduzione via insertIngredientTranslation. */
async function createIngredient(name: string): Promise<UUID> {
  const categoryId = await getOrCreateFallbackCategory();

  const id = uuidv4();
  await query(
    `INSERT INTO ingredients (id, category_id, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (category_id, name) DO NOTHING`,
    [id, categoryId, name]
  );

  // Se già esisteva, rileggi l'id
  const existing = await queryOne<{ id: UUID }>(
    "SELECT id FROM ingredients WHERE LOWER(name)=LOWER($1) LIMIT 1",
    [name]
  );
  return existing?.id ?? id;
}

async function insertIngredientTranslation(ingredientId: UUID, languageCode: string, translatedName: string): Promise<void> {
  await query(
    `INSERT INTO ingredient_translations (ingredient_id, language_code, translated_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (ingredient_id, language_code) DO UPDATE SET translated_name = excluded.translated_name`,
    [ingredientId, languageCode, translatedName]
  );
}

// ── Tool Matching ──────────────────────────────────────────────────────

export interface MatchedTool {
  toolId: UUID;
  toolName: string;
  isNew: boolean;
}

/** Trova lo strumento più simile nel DB (soglia 0.7) */
async function findBestToolMatch(
  name: string,
  allTools: DBTool[]
): Promise<{ tool: DBTool; score: number } | null> {
  let best: { tool: DBTool; score: number } | null = null;

  for (const tool of allTools) {
    const score = similarity(name, tool.name);
    if (score > 0.7 && (!best || score > best.score)) {
      best = { tool, score };
    }
  }

  return best;
}

/** Crea un nuovo strumento nel DB (senza categoria) */
async function createTool(name: string): Promise<UUID> {
  const id = uuidv4();
  await query(
    `INSERT INTO tools (id, name) VALUES ($1, $2)
     ON CONFLICT (name) WHERE deleted_at IS NULL DO NOTHING`,
    [id, name]
  );

  const existing = await queryOne<{ id: UUID }>(
    "SELECT id FROM tools WHERE LOWER(name)=LOWER($1) AND deleted_at IS NULL LIMIT 1",
    [name]
  );
  return existing?.id ?? id;
}

/** Mappa nomi strumenti estratti dall'LLM a strumenti nel DB, creando quelli mancanti */
export async function matchTools(toolNames: string[]): Promise<MatchedTool[]> {
  if (!toolNames.length) return [];

  const allTools = await query<DBTool>("SELECT id, name FROM tools WHERE deleted_at IS NULL");
  const matched: MatchedTool[] = [];

  for (const name of toolNames) {
    const bestMatch = await findBestToolMatch(name, allTools);
    if (bestMatch) {
      matched.push({ toolId: bestMatch.tool.id, toolName: bestMatch.tool.name, isNew: false });
    } else {
      const newId = await createTool(name);
      matched.push({ toolId: newId, toolName: name, isNew: true });
    }
  }

  return matched;
}

// ── Technique Matching ─────────────────────────────────────────────────

export interface MatchedTechnique {
  techniqueId: UUID;
  techniqueName: string;
  isNew: boolean;
}

/** Trova la tecnica più simile nel DB (soglia 0.7) */
async function findBestTechniqueMatch(
  name: string,
  allTechniques: DBTechnique[]
): Promise<{ technique: DBTechnique; score: number } | null> {
  let best: { technique: DBTechnique; score: number } | null = null;

  for (const technique of allTechniques) {
    const score = similarity(name, technique.name);
    if (score > 0.7 && (!best || score > best.score)) {
      best = { technique, score };
    }
  }

  return best;
}

/** Crea una nuova tecnica nel DB (senza categoria) */
async function createTechnique(name: string): Promise<UUID> {
  const id = uuidv4();
  await query(
    `INSERT INTO techniques (id, name) VALUES ($1, $2)
     ON CONFLICT (name) WHERE deleted_at IS NULL DO NOTHING`,
    [id, name]
  );

  const existing = await queryOne<{ id: UUID }>(
    "SELECT id FROM techniques WHERE LOWER(name)=LOWER($1) AND deleted_at IS NULL LIMIT 1",
    [name]
  );
  return existing?.id ?? id;
}

/** Mappa nomi tecniche estratte dall'LLM a tecniche nel DB, creando quelle mancanti */
export async function matchTechniques(techniqueNames: string[]): Promise<MatchedTechnique[]> {
  if (!techniqueNames.length) return [];

  const allTechniques = await query<DBTechnique>("SELECT id, name FROM techniques WHERE deleted_at IS NULL");
  const matched: MatchedTechnique[] = [];

  for (const name of techniqueNames) {
    const bestMatch = await findBestTechniqueMatch(name, allTechniques);
    if (bestMatch) {
      matched.push({ techniqueId: bestMatch.technique.id, techniqueName: bestMatch.technique.name, isNew: false });
    } else {
      const newId = await createTechnique(name);
      matched.push({ techniqueId: newId, techniqueName: name, isNew: true });
    }
  }

  return matched;
}

// ── Propose-only matching (no DB writes) ──────────────────────────────
// Used by POST /recipes/parse (returns the raw LLM result unmatched) and
// POST /recipes/match-suggestions (same scoring for the local/non-AI parser
// path) — the Review Matches step on the frontend calls the latter for
// both parsing paths uniformly, then commits chosen/created items itself
// via the existing POST /ingredients, /tools, /techniques endpoints.
// matchLLMResultToDB() above is left in place only for llm.ts's
// unreferenced-from-the-frontend /parse+/confirm pair.

export interface MatchSuggestion { id: UUID; name: string; score: number; }

// ── Localized suggestions ───────────────────────────────────────
// Mirrors frontend/src/services/localMatcher.ts — keep the two in step.
// These used to select only the base (English) name, so the Import review
// step offered "Butter" for a parsed "burro" whatever language the app was
// set to. Worse than the label: scoring an Italian name against an English
// catalog is close to noise ("cocco rapè" came back as "Arborio Rice" at
// 42%). So `lang` picks the translated name for BOTH the score and the
// label, while the base name stays in the running as a second probe — a
// recipe may well be parsed in a different language than the UI.

/** Best score across every name a row is known by. `label` is what gets
 *  shown; all of `probes` are scored and the highest wins. */
function bestOf(name: string, probes: Array<string | null | undefined>): number {
  const usable = probes.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  return usable.length ? Math.max(...usable.map((p) => similarity(name, p))) : 0;
}

function rank(
  name: string,
  rows: Array<{ id: UUID; label: string; probes: Array<string | null | undefined> }>
): MatchSuggestion[] {
  return rows
    .map((r) => ({ id: r.id, name: r.label, score: bestOf(name, r.probes) }))
    .filter((s) => s.score > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

type TranslatedRow = { translated_name: string | null };

export async function proposeIngredientMatches(names: string[], lang?: string): Promise<Record<string, MatchSuggestion[]>> {
  if (!names.length) return {};
  const all = await query<DBIngredient & TranslatedRow & { synonyms: string[] | null }>(
    `SELECT i.id, i.name, i.category_id, i.plural_name, i.synonyms,
            ${lang ? "tr.translated_name" : "NULL AS translated_name"}
     FROM ingredients i
     ${lang ? "LEFT JOIN ingredient_translations tr ON tr.ingredient_id = i.id AND LOWER(tr.language_code) = LOWER($1)" : ""}
     WHERE i.sync_status != 'deleted'`,
    lang ? [lang] : []
  );
  const rows = all.map((ing) => ({
    id: ing.id,
    label: ing.translated_name || ing.name,
    // Synonyms are exactly the alternate names someone recorded so this
    // ingredient would be findable by them; leaving them out of the probe
    // list meant the catalog knew "scalogno" was a Shallot and the review
    // step still didn't.
    probes: [ing.translated_name, ing.name, ing.plural_name, ...(ing.synonyms ?? [])],
  }));
  const out: Record<string, MatchSuggestion[]> = {};
  for (const name of names) out[name] = rank(name, rows);
  return out;
}

export async function proposeToolMatches(names: string[], lang?: string): Promise<Record<string, MatchSuggestion[]>> {
  if (!names.length) return {};
  const all = await query<DBTool & TranslatedRow & { synonyms: string[] | null }>(
    `SELECT t.id, t.name, t.synonyms,
            ${lang ? "tr.name AS translated_name" : "NULL AS translated_name"}
     FROM tools t
     ${lang ? "LEFT JOIN tool_translations tr ON tr.tool_id = t.id AND LOWER(tr.language_code) = LOWER($1)" : ""}
     WHERE t.deleted_at IS NULL`,
    lang ? [lang] : []
  );
  const rows = all.map((t) => ({
    id: t.id,
    label: t.translated_name || t.name,
    probes: [t.translated_name, t.name, ...(t.synonyms ?? [])],
  }));
  const out: Record<string, MatchSuggestion[]> = {};
  for (const name of names) out[name] = rank(name, rows);
  return out;
}

export async function proposeTechniqueMatches(names: string[], lang?: string): Promise<Record<string, MatchSuggestion[]>> {
  if (!names.length) return {};
  const all = await query<DBTechnique & TranslatedRow & { synonyms: string[] | null }>(
    `SELECT t.id, t.name, t.synonyms,
            ${lang ? "tr.name AS translated_name" : "NULL AS translated_name"}
     FROM techniques t
     ${lang ? "LEFT JOIN technique_translations tr ON tr.technique_id = t.id AND LOWER(tr.language_code) = LOWER($1)" : ""}
     WHERE t.deleted_at IS NULL`,
    lang ? [lang] : []
  );
  const rows = all.map((t) => ({
    id: t.id,
    label: t.translated_name || t.name,
    probes: [t.translated_name, t.name, ...(t.synonyms ?? [])],
  }));
  const out: Record<string, MatchSuggestion[]> = {};
  for (const name of names) out[name] = rank(name, rows);
  return out;
}

// ── Main Entry Point ───────────────────────────────────────────────────

export type MatchedStep = LLMParseResult["steps"][number] & { techniqueIds: UUID[] };

export interface RecipeMatchResult {
  title: string;
  language?: string;
  description?: string;
  servings: number;
  prepTimeMin?: number;
  cookTimeMin?: number;
  restTimeMin?: number;
  difficulty: string;
  tags: string[];
  sourceUrl?: string;
  storageInstructions?: string | null;
  tips?: string | null;
  matchedIngredients: MatchedIngredient[];
  matchedTools: MatchedTool[];
  steps: MatchedStep[];
  overallConfidence: number;
  warnings: string[];
}

/**
 * Prende il risultato grezzo dell'LLM e risolve ogni ingrediente
 * contro il DB, creando automaticamente quelli non trovati.
 */
export async function matchLLMResultToDB(
  llmResult: LLMParseResult
): Promise<RecipeMatchResult> {
  // Carica tutti gli ingredienti dal DB una sola volta
  const allIngredients = await query<DBIngredient>(
    "SELECT id, name, category_id, plural_name FROM ingredients WHERE sync_status != 'deleted'"
  );

  const warnings = [...llmResult.warnings];

  // Prima passata: risolvi i match, ma rimanda la creazione dei nuovi
  // ingredienti — servono tutti i nomi da creare in una volta per poterli
  // tradurre in un'unica chiamata batch (vedi sotto), invece che una
  // chiamata LLM per ingrediente.
  type Plan =
    | { type: "matched"; ing: LLMParseResult["ingredients"][number]; unitId: UUID | null; match: { ingredient: DBIngredient; score: number } }
    | { type: "new"; ing: LLMParseResult["ingredients"][number]; unitId: UUID | null };

  const plan: Plan[] = [];
  for (const ing of llmResult.ingredients) {
    const bestMatch = await findBestMatch(ing.name, allIngredients);
    const unitId = await matchUnit(ing.unit);
    plan.push(bestMatch ? { type: "matched", ing, unitId, match: bestMatch } : { type: "new", ing, unitId });
  }

  // Il nome-base degli ingredienti è per convenzione in inglese (vedi
  // createIngredient sopra). Se la ricetta è in un'altra lingua, traduci i
  // nomi dei nuovi ingredienti in inglese prima di crearli, e conserva il
  // nome originale come traduzione — altrimenti l'ingrediente resterebbe
  // "bloccato" in quella lingua anche quando l'utente cambia lingua di
  // visualizzazione (il fallback COALESCE(translated_name, i.name) non ha
  // nulla da restituire nelle altre lingue). Best-effort: se la traduzione
  // fallisce, si ricade sul comportamento precedente (nome originale).
  let translations: Record<string, string> = {};
  const newNames = plan.filter((p): p is Extract<Plan, { type: "new" }> => p.type === "new").map((p) => p.ing.name);
  if (newNames.length > 0 && llmResult.language && llmResult.language !== "en") {
    try {
      const { translateIngredientNames } = await import("./llm.parser");
      translations = await translateIngredientNames([...new Set(newNames)], llmResult.language, "en");
    } catch (err) {
      console.warn("⚠️ Ingredient name translation failed, keeping original-language names:", (err as Error).message);
    }
  }

  const matchedIngredients: MatchedIngredient[] = [];

  for (const p of plan) {
    const { ing, unitId } = p;

    if (p.type === "matched") {
      const bestMatch = p.match;
      matchedIngredients.push({
        ingredientId: bestMatch.ingredient.id,
        ingredientName: bestMatch.ingredient.name,
        confidence: bestMatch.score,
        isNew: false,
        unitId: unitId ?? undefined,
        quantity: ing.quantity,
        quantityText: ing.quantityText,
        notes: ing.notes,
        groupName: ing.groupName ?? null,
      });

      if (bestMatch.score < 0.9) {
        warnings.push(
          `ℹ️ "${ing.name}" mappato a "${bestMatch.ingredient.name}" ` +
          `(similarità: ${(bestMatch.score * 100).toFixed(0)}%)`
        );
      }
    } else {
      // Crea nuovo ingrediente — nome inglese tradotto se disponibile,
      // altrimenti il nome originale così come estratto dall'LLM.
      const englishName = translations[ing.name] ?? ing.name;
      const newId = await createIngredient(englishName);
      if (translations[ing.name] && llmResult.language) {
        await insertIngredientTranslation(newId, llmResult.language, ing.name);
      }
      matchedIngredients.push({
        ingredientId: newId,
        ingredientName: englishName,
        confidence: 1.0,
        isNew: true,
        unitId: unitId ?? undefined,
        quantity: ing.quantity,
        quantityText: ing.quantityText,
        notes: ing.notes,
        groupName: ing.groupName ?? null,
      });
      warnings.push(`🆕 Nuovo ingrediente creato: "${ing.name}"`);
    }
  }

  const matchedTools = await matchTools(llmResult.tools ?? []);
  for (const t of matchedTools) {
    if (t.isNew) warnings.push(`🆕 Nuovo strumento creato: "${t.toolName}"`);
  }

  // Le tecniche sono per-step, ma vengono risolte in un'unica passata come
  // tools sopra: dedup dei nomi su tutta la ricetta, un'unica query/batch di
  // creazione, poi rimappate per nome su ciascuno step.
  const allTechniqueNames = [...new Set(llmResult.steps.flatMap((s) => s.techniques ?? []))];
  const matchedTechniques = await matchTechniques(allTechniqueNames);
  for (const t of matchedTechniques) {
    if (t.isNew) warnings.push(`🆕 Nuova tecnica creata: "${t.techniqueName}"`);
  }
  const techniqueIdByName = new Map(matchedTechniques.map((t, i) => [allTechniqueNames[i], t.techniqueId]));
  const steps: MatchedStep[] = llmResult.steps.map((s) => ({
    ...s,
    techniqueIds: (s.techniques ?? [])
      .map((name) => techniqueIdByName.get(name))
      .filter((id): id is UUID => !!id),
  }));

  const avgConfidence =
    matchedIngredients.reduce((s, i) => s + i.confidence, 0) /
    (matchedIngredients.length || 1);

  return {
    title: llmResult.title,
    language: llmResult.language,
    description: llmResult.description,
    servings: llmResult.servings ?? 4,
    prepTimeMin: llmResult.prepTimeMin,
    cookTimeMin: llmResult.cookTimeMin,
    restTimeMin: llmResult.restTimeMin,
    difficulty: llmResult.difficulty ?? "medium",
    tags: llmResult.tags,
    sourceUrl: llmResult.sourceUrl,
    storageInstructions: llmResult.storageInstructions ?? null,
    tips: llmResult.tips ?? null,
    matchedIngredients,
    matchedTools,
    steps,
    overallConfidence: llmResult.confidence * avgConfidence,
    warnings,
  };
}
