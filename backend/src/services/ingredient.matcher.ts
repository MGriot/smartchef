// ════════════════════════════════════════════════════════════════════════
// SmartChef — Ingredient Matcher
// Mappa i nomi ingredienti estratti dall'LLM agli ingredienti nel DB,
// usando similarità stringa + fallback a creazione automatica
// ════════════════════════════════════════════════════════════════════════

import { query, queryOne } from "../db/pool";
import { v4 as uuidv4 } from "uuid";
import type { LLMParseResult, UUID } from "@shared/types/index";

interface DBIngredient { id: UUID; name: string; category_id: UUID; }
interface DBUnit       { id: UUID; symbol: string; name: string; }

// ── Fuzzy String Match ─────────────────────────────────────────────────

/** Normalizza stringa per confronto: lowercase, rimuovi accenti e spazi extra */
function normalize(s: string): string {
  return s.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

/** Calcola similarità Levenshtein normalizzata (0–1) */
function similarity(a: string, b: string): number {
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
}

/** Trova l'ingrediente più simile nel DB (soglia 0.7) */
async function findBestMatch(
  name: string,
  allIngredients: DBIngredient[]
): Promise<{ ingredient: DBIngredient; score: number } | null> {
  let best: { ingredient: DBIngredient; score: number } | null = null;

  for (const ing of allIngredients) {
    const score = similarity(name, ing.name);
    if (score > 0.7 && (!best || score > best.score)) {
      best = { ingredient: ing, score };
    }
  }

  return best;
}

/** Trova la categoria "Altro", creandola se non esiste ancora */
async function getOrCreateFallbackCategory(): Promise<UUID> {
  const existing = await queryOne<{ id: UUID }>(
    "SELECT id FROM ingredient_categories WHERE name='Altro' LIMIT 1"
  );
  if (existing) return existing.id;

  const id = uuidv4();
  await query(
    `INSERT INTO ingredient_categories (id, name) VALUES ($1, 'Altro')
     ON CONFLICT (name) DO NOTHING`,
    [id]
  );
  const row = await queryOne<{ id: UUID }>(
    "SELECT id FROM ingredient_categories WHERE name='Altro' LIMIT 1"
  );
  return row!.id;
}

/** Crea un nuovo ingrediente nel DB nella categoria "Altro" */
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

// ── Main Entry Point ───────────────────────────────────────────────────

export interface RecipeMatchResult {
  title: string;
  description?: string;
  servings: number;
  prepTimeMin?: number;
  cookTimeMin?: number;
  difficulty: string;
  tags: string[];
  sourceUrl?: string;
  matchedIngredients: MatchedIngredient[];
  steps: LLMParseResult["steps"];
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
    "SELECT id, name, category_id FROM ingredients WHERE sync_status != 'deleted'"
  );

  const matchedIngredients: MatchedIngredient[] = [];
  const warnings = [...llmResult.warnings];

  for (const ing of llmResult.ingredients) {
    const bestMatch = await findBestMatch(ing.name, allIngredients);
    const unitId = await matchUnit(ing.unit);

    if (bestMatch) {
      matchedIngredients.push({
        ingredientId: bestMatch.ingredient.id,
        ingredientName: bestMatch.ingredient.name,
        confidence: bestMatch.score,
        isNew: false,
        unitId: unitId ?? undefined,
        quantity: ing.quantity,
        quantityText: ing.quantityText,
        notes: ing.notes,
      });

      if (bestMatch.score < 0.9) {
        warnings.push(
          `ℹ️ "${ing.name}" mappato a "${bestMatch.ingredient.name}" ` +
          `(similarità: ${(bestMatch.score * 100).toFixed(0)}%)`
        );
      }
    } else {
      // Crea nuovo ingrediente
      const newId = await createIngredient(ing.name);
      matchedIngredients.push({
        ingredientId: newId,
        ingredientName: ing.name,
        confidence: 1.0,
        isNew: true,
        unitId: unitId ?? undefined,
        quantity: ing.quantity,
        quantityText: ing.quantityText,
        notes: ing.notes,
      });
      warnings.push(`🆕 Nuovo ingrediente creato: "${ing.name}"`);
    }
  }

  const avgConfidence =
    matchedIngredients.reduce((s, i) => s + i.confidence, 0) /
    (matchedIngredients.length || 1);

  return {
    title: llmResult.title,
    description: llmResult.description,
    servings: llmResult.servings ?? 4,
    prepTimeMin: llmResult.prepTimeMin,
    cookTimeMin: llmResult.cookTimeMin,
    difficulty: llmResult.difficulty ?? "medium",
    tags: llmResult.tags,
    sourceUrl: llmResult.sourceUrl,
    matchedIngredients,
    steps: llmResult.steps,
    overallConfidence: llmResult.confidence * avgConfidence,
    warnings,
  };
}
