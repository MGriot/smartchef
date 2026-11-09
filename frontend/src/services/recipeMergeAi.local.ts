// "Merge with AI" for several recipes: loads them, asks the configured
// model which ingredients and steps of the copies repeat the kept recipe,
// and hands back the proposal for the user to tick through. Nothing is
// written here — see lib/recipeMergeAi.ts for why the model can only advise.

import i18n from '../i18n';
import { callConfiguredProvider, LONG_AI_TIMEOUT_MS, parseJsonObject } from './llmParser.local';
import { getRecipe } from './recipes.local';
import {
  buildMergeManyRequest, buildMergeManySystemPrompt, interpretMergeManyResponse,
  type MergeAiProposal, type MergeAiRecipe,
} from '../lib/recipeMergeAi';
import { STEP_REF_RE, parseRefParams } from '../lib/stepRefs';

/** Most copies one AI merge takes: the request carries every row of all of them. */
export const MAX_AI_MERGE_RECIPES = 6;

async function loadForMerge(id: string, lang?: string): Promise<MergeAiRecipe> {
  const recipe: any = await getRecipe(id, lang);
  if (!recipe) throw new Error(i18n.t('errors.recipeNotFound'));
  const names: string[] = [];
  for (const ing of recipe.ingredients ?? []) names[Number(ing.sortOrder)] = ing.ingredientName || ing.subRecipeTitle || '';
  const toolName = new Map<string, string>((recipe.tools ?? []).map((t: any) => [String(t.id), t.translated_name || t.name]));
  const techName = new Map<string, string>((recipe.techniques ?? []).map((t: any) => [String(t.id), t.translated_name || t.name]));
  const plain = (text: string) => text.replace(STEP_REF_RE, (whole, type: string, refId: string, raw?: string) => {
    const key = refId.trim();
    if (type === 'ing') return parseRefParams(raw).alias || names[Number(key)] || whole;
    return (type === 'tool' ? toolName.get(key) : techName.get(key)) ?? whole;
  });
  return {
    id: recipe.id,
    title: recipe.translated_title || recipe.title,
    ingredients: (recipe.ingredients ?? []).map((ing: any) => ({
      id: String(ing.id),
      label: ing.ingredientName || ing.subRecipeTitle || '',
      quantity: ing.quantity != null ? Number(ing.quantity) : null,
      unit: ing.unitSymbol ?? null,
      notes: ing.translatedNotes || ing.notes || null,
    })),
    steps: (recipe.steps ?? []).map((s: any) => ({
      id: String(s.id),
      title: s.translatedTitle || s.title || null,
      text: plain(s.translatedDescription || s.description || ''),
      durationMin: s.durationMin ?? null,
    })),
  };
}

/** `keptId` first, then the copies. */
export async function proposeRecipesMerge(
  keptId: string,
  otherIds: string[],
  lang?: string,
): Promise<{ recipes: MergeAiRecipe[]; proposal: MergeAiProposal }> {
  const ids = [keptId, ...new Set(otherIds.filter((id) => id !== keptId))];
  if (ids.length < 2) throw new Error(i18n.t('errors.recipeRequired'));
  if (ids.length > MAX_AI_MERGE_RECIPES) throw new Error(i18n.t('errors.tooManyRecipesToMerge', { count: MAX_AI_MERGE_RECIPES }));
  const recipes = await Promise.all(ids.map((id) => loadForMerge(id, lang)));
  const raw = await callConfiguredProvider(
    JSON.stringify(buildMergeManyRequest(recipes)), buildMergeManySystemPrompt(), undefined, { timeoutMs: LONG_AI_TIMEOUT_MS },
  );
  return { recipes, proposal: interpretMergeManyResponse(parseJsonObject(raw), recipes) };
}
