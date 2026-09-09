// ════════════════════════════════════════════════════════════════════════
// SmartChef — Local (non-AI) recipe text parser
// Recognizes two shapes without ever calling an LLM: (1) JSON already in
// the shape parseRecipeWithLLM() produces (backend/src/services/llm.parser.ts),
// passed straight through; (2) plain text following the "Use Template"
// structure offered on the Import screen (see import.rawTextTemplate in
// frontend/src/i18n/locales/*.json — the field-label aliases below must
// stay in sync with those four templates). Anything else returns null,
// meaning the caller still needs the AI path (freeform prose).
// ════════════════════════════════════════════════════════════════════════

import { parseAmount } from '../lib/ingredientAmount';

export interface TemplateParseIngredient {
  name: string;
  quantity?: number;
  quantityText?: string;
  unit?: string;
  notes?: string;
  groupName?: string | null;
}

export interface TemplateParseStep {
  stepNumber: number;
  title?: string;
  description: string;
  durationMin?: number;
  // Only ever populated by the AI path (adaptAiResult() in RecipeImport.tsx)
  // — the text template has no per-step technique field, so the local
  // parser never sets this.
  techniques?: string[];
}

// Shared "parsed but not yet matched against the library" shape — produced
// either by tryParseStructuredText() below (no AI) or by adapting the AI
// /api/recipes/parse response (RecipeImport.tsx's adaptAiResult()). Both
// feed the same Review Matches step afterward, per ADR-style decision:
// matching should behave identically regardless of how the recipe was
// parsed.
export interface TemplateParseResult {
  title: string;
  language?: string;
  description?: string;
  servings?: number;
  prepTimeMin?: number;
  cookTimeMin?: number;
  restTimeMin?: number;
  difficulty?: string;
  tags: string[];
  tools: string[];
  storageInstructions?: string | null;
  tips?: string | null;
  ingredients: TemplateParseIngredient[];
  steps: TemplateParseStep[];
  warnings: string[];
  sourceUrl?: string;
  // Only ever set by the AI path (the LLM's own confidence in its
  // extraction) — the local parser has no equivalent notion, so this stays
  // undefined for a template/JSON-parsed draft.
  confidence?: number;
}

// One row per template field, across every locale's label wording (see the
// four rawTextTemplate strings). Matched case-insensitively against the
// start of a line, optional space before ":"/":" (French uses "Titre :").
const FIELD_ALIASES: Record<string, string[]> = {
  title: ['Titolo', 'Title', 'Titre', 'Título'],
  description: ['Descrizione', 'Description', 'Descripción'],
  language: ['Lingua', 'Language', 'Langue', 'Idioma'],
  servings: ['Porzioni', 'Servings', 'Portions', 'Porciones'],
  prepTimeMin: ['Tempo di preparazione', 'Prep time', 'Temps de préparation', 'Tiempo de preparación'],
  cookTimeMin: ['Tempo di cottura', 'Cook time', 'Temps de cuisson', 'Tiempo de cocción'],
  restTimeMin: ['Tempo di riposo', 'Rest time', 'Temps de repos', 'Tiempo de reposo'],
  difficulty: ['Difficoltà', 'Difficulty', 'Difficulté', 'Dificultad'],
  tags: ['Tag', 'Tags', 'Étiquettes', 'Etiquetas'],
  tools: ['Strumenti', 'Tools', 'Ustensiles', 'Utensilios'],
  storageInstructions: ['Come conservare', 'Storage', 'Conservation', 'Conservación'],
  tips: ['Consigli', 'Tips', 'Conseils', 'Consejos'],
};

const INGREDIENTS_LABELS = ['Ingredienti', 'Ingredients', 'Ingrédients', 'Ingredientes'];
const STEPS_LABELS = ['Passaggi', 'Steps', 'Étapes', 'Pasos'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches "Label:" or "Label :" (French) at the start of a line, any of
 *  the given alias spellings, case-insensitive. Returns the value after
 *  the colon, or null if this line doesn't start with any alias. */
function matchLabel(line: string, aliases: string[]): string | null {
  for (const alias of aliases) {
    const re = new RegExp(`^${escapeRegExp(alias)}\\s*:\\s*(.*)$`, 'i');
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function lineStartsWithAnyLabel(line: string, allAliasLists: string[][]): boolean {
  return allAliasLists.some((aliases) => matchLabel(line, aliases) !== null);
}


/** Whole-number scalar fields (servings, the time fields) — deliberately
 *  NOT parseAmount(): these are never fractions, and reading "1 1/2" out of
 *  a minutes field as 1.5 would be worse than reading it as 1. */
function parseFirstNumber(text: string): number | undefined {
  const m = text.match(/[\d]+(?:[.,]\d+)?/);
  if (!m) return undefined;
  return parseFloat(m[0].replace(',', '.'));
}

function splitCommaList(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

// Ingredient line: "- [qty] [unit] name (notes)" — quantity/unit/notes are
// all optional and best-effort, matching the LLM prompt's own "if unclear,
// just capture the name" philosophy rather than failing outright.
const INGREDIENT_LINE_RE = /^-\s*(?:([\d.,/]+)\s+)?(?:([a-zA-Zàèéìòùâêîôûäöüñç]+)\s+)?(.+?)(?:\s*\(([^)]+)\))?$/;

function parseIngredientLine(line: string): TemplateParseIngredient | null {
  const stripped = line.replace(/^-\s*/, '').trim();
  if (!stripped) return null;
  const m = line.match(INGREDIENT_LINE_RE);
  if (!m) return { name: stripped };
  const [, qtyRaw, unitRaw, nameRaw, notesRaw] = m;
  // parseAmount(), not a bare digit match: INGREDIENT_LINE_RE's amount
  // group already accepts "/" and this line may well read "- 1/2 cipolla",
  // which used to come through as quantity 1.
  const quantity = qtyRaw ? parseAmount(qtyRaw) : undefined;
  return {
    name: (nameRaw || stripped).trim(),
    quantity,
    quantityText: qtyRaw?.trim(),
    unit: unitRaw?.trim(),
    notes: notesRaw?.trim(),
  };
}

const STEP_LINE_RE = /^(\d+)[.)]\s*(.*)$/;

/** Tries JSON first (a direct LLM-schema-shaped payload — see
 *  backend/src/services/llm.parser.ts's output shape), then the
 *  template's structured-text shape. Returns null for freeform prose,
 *  meaning the caller still needs the AI path. */
export function tryParseStructuredText(text: string): TemplateParseResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const jsonResult = tryParseAsJson(trimmed);
  if (jsonResult) return jsonResult;

  return tryParseAsTemplate(trimmed);
}

function tryParseAsJson(text: string): TemplateParseResult | null {
  if (!(text.startsWith('{') || text.startsWith('['))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.title !== 'string' || !Array.isArray(obj.ingredients)) return null;

  const ingredients: TemplateParseIngredient[] = (obj.ingredients as unknown[]).map((raw) => {
    const i = (raw ?? {}) as Record<string, unknown>;
    return {
      name: typeof i.name === 'string' ? i.name : String(i.name ?? ''),
      quantity: typeof i.quantity === 'number' ? i.quantity : undefined,
      quantityText: typeof i.quantityText === 'string' ? i.quantityText : undefined,
      unit: typeof i.unit === 'string' ? i.unit : undefined,
      notes: typeof i.notes === 'string' ? i.notes : undefined,
      groupName: typeof i.groupName === 'string' ? i.groupName : null,
    };
  });
  const steps: TemplateParseStep[] = Array.isArray(obj.steps)
    ? (obj.steps as unknown[]).map((raw, idx) => {
        const s = (raw ?? {}) as Record<string, unknown>;
        return {
          stepNumber: typeof s.stepNumber === 'number' ? s.stepNumber : idx + 1,
          title: typeof s.title === 'string' ? s.title : undefined,
          description: typeof s.description === 'string' ? s.description : '',
          durationMin: typeof s.durationMin === 'number' ? s.durationMin : undefined,
        };
      })
    : [];

  return {
    title: obj.title,
    language: typeof obj.language === 'string' ? obj.language : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    servings: typeof obj.servings === 'number' ? obj.servings : undefined,
    prepTimeMin: typeof obj.prepTimeMin === 'number' ? obj.prepTimeMin : undefined,
    cookTimeMin: typeof obj.cookTimeMin === 'number' ? obj.cookTimeMin : undefined,
    restTimeMin: typeof obj.restTimeMin === 'number' ? obj.restTimeMin : undefined,
    difficulty: typeof obj.difficulty === 'string' ? obj.difficulty : undefined,
    tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string') : [],
    tools: Array.isArray(obj.tools) ? obj.tools.filter((t): t is string => typeof t === 'string') : [],
    storageInstructions: typeof obj.storageInstructions === 'string' ? obj.storageInstructions : null,
    tips: typeof obj.tips === 'string' ? obj.tips : null,
    ingredients,
    steps,
    warnings: Array.isArray(obj.warnings) ? obj.warnings.filter((w): w is string => typeof w === 'string') : [],
  };
}

function tryParseAsTemplate(text: string): TemplateParseResult | null {
  const lines = text.split(/\r?\n/);
  const allLabelSets = [...Object.values(FIELD_ALIASES), INGREDIENTS_LABELS, STEPS_LABELS];
  const recognizedLabelCount = lines.filter((l) => lineStartsWithAnyLabel(l.trim(), allLabelSets)).length;
  // Need at least 2 recognizable field labels before treating this as
  // template-shaped — a single coincidental match (e.g. a line that
  // happens to start with "Title:") shouldn't hijack genuinely freeform text.
  if (recognizedLabelCount < 2) return null;

  const warnings: string[] = [];
  const fields: Record<string, string> = {};
  let ingredientsStart = -1;
  let stepsStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (ingredientsStart === -1 && INGREDIENTS_LABELS.some((l) => matchLabel(line, [l]) !== null)) {
      ingredientsStart = i;
      continue;
    }
    if (STEPS_LABELS.some((l) => matchLabel(line, [l]) !== null)) {
      stepsStart = i;
      continue;
    }
    if (ingredientsStart !== -1) continue; // body lines handled in the block scan below
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      const value = matchLabel(line, aliases);
      if (value !== null) {
        fields[field] = value;
        break;
      }
    }
  }

  const ingredients: TemplateParseIngredient[] = [];
  if (ingredientsStart !== -1) {
    const end = stepsStart !== -1 ? stepsStart : lines.length;
    for (let i = ingredientsStart + 1; i < end; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('-') === false) continue;
      const ing = parseIngredientLine(line);
      if (ing && ing.name) ingredients.push(ing);
    }
  } else {
    warnings.push('No "Ingredients:" section found.');
  }

  const steps: TemplateParseStep[] = [];
  if (stepsStart !== -1) {
    // Steps run until the next recognized field label (Storage:/Tips:) or EOF.
    let end = lines.length;
    for (let i = stepsStart + 1; i < lines.length; i++) {
      if (lineStartsWithAnyLabel(lines[i].trim(), [FIELD_ALIASES.storageInstructions, FIELD_ALIASES.tips])) {
        end = i;
        break;
      }
    }
    let stepNumber = 1;
    for (let i = stepsStart + 1; i < end; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const m = line.match(STEP_LINE_RE);
      const description = (m ? m[2] : line).trim();
      if (!description) continue;
      steps.push({ stepNumber: m ? parseInt(m[1], 10) : stepNumber, description });
      stepNumber++;
    }
  } else {
    warnings.push('No "Steps:" section found.');
  }

  if (!fields.title) warnings.push('No title found.');
  if (ingredients.length === 0) warnings.push('No ingredients could be parsed.');
  if (steps.length === 0) warnings.push('No steps could be parsed.');

  return {
    title: fields.title || '',
    language: fields.language || undefined,
    description: fields.description || undefined,
    servings: fields.servings ? parseFirstNumber(fields.servings) : undefined,
    prepTimeMin: fields.prepTimeMin ? parseFirstNumber(fields.prepTimeMin) : undefined,
    cookTimeMin: fields.cookTimeMin ? parseFirstNumber(fields.cookTimeMin) : undefined,
    restTimeMin: fields.restTimeMin ? parseFirstNumber(fields.restTimeMin) : undefined,
    difficulty: fields.difficulty || undefined,
    tags: fields.tags ? splitCommaList(fields.tags) : [],
    tools: fields.tools ? splitCommaList(fields.tools) : [],
    storageInstructions: fields.storageInstructions || null,
    tips: fields.tips || null,
    ingredients,
    steps,
    warnings,
  };
}
