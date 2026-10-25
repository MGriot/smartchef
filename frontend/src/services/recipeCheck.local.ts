// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Check with AI" for the recipe editor, standalone mode
//
// POST /api/recipes/ai-check → checkRecipeWithAi(). The recipe (the editor's
// current draft, unsaved edits included) goes out, a list of verified,
// individually reviewable changes comes back. The rules that keep the model
// from inventing anything live in lib/recipeCheck.ts.
// ════════════════════════════════════════════════════════════════════════

import { callConfiguredProvider, parseJsonObject } from './llmParser.local';
import {
  buildCheckRequest, buildCheckSystemPrompt, interpretCheckResponse,
  type CheckCatalog, type CheckDraft, type CheckResult,
} from '../lib/recipeCheck';
import type { IngredientMismatch } from '../lib/recipeConsistency';
import { buildMergeRequest, buildMergeSystemPrompt, interpretMergeResponse } from '../lib/recipeMerge';
import {
  buildFixRequest, buildFixSystemPrompt, interpretFixResponse,
  type MismatchFixResult, type MismatchSide,
} from '../lib/recipeMismatchFix';

export async function checkRecipeWithAi(draft: CheckDraft, catalog: CheckCatalog): Promise<CheckResult> {
  const request = buildCheckRequest(draft, catalog);
  const raw = await callConfiguredProvider(JSON.stringify(request), buildCheckSystemPrompt(catalog));
  return interpretCheckResponse(parseJsonObject(raw), draft, catalog);
}

/** "Merge text with AI": the draft plus a text the user pasted; back come
 *  the changes that text supports, checked against it in lib/recipeMerge.ts. */
export async function mergeTextWithAi(draft: CheckDraft, text: string, catalog: CheckCatalog): Promise<CheckResult> {
  const request = buildMergeRequest(draft, text, catalog);
  const raw = await callConfiguredProvider(JSON.stringify(request), buildMergeSystemPrompt(catalog));
  return interpretMergeResponse(parseJsonObject(raw), draft, text, catalog);
}

/** The second call of the mismatch flow: the user said which side of the
 *  disagreement is right, the model brings the other side into line. What
 *  comes back is checked in lib/recipeMismatchFix.ts like any other proposal. */
export async function resolveMismatchWithAi(
  side: MismatchSide,
  draft: CheckDraft,
  catalog: CheckCatalog,
  mismatch: IngredientMismatch,
): Promise<MismatchFixResult> {
  const request = buildFixRequest(side, draft, catalog, mismatch);
  const raw = await callConfiguredProvider(JSON.stringify(request), buildFixSystemPrompt(side));
  return interpretFixResponse(side, parseJsonObject(raw), draft, catalog, mismatch);
}
