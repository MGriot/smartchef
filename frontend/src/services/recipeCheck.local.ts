// ════════════════════════════════════════════════════════════════════════
// SmartChef — "Check with AI" for the recipe editor, standalone mode
//
// POST /api/recipes/ai-check → checkRecipeWithAi(). The recipe (the editor's
// current draft, unsaved edits included) goes out, a list of verified,
// individually reviewable changes comes back. The rules that keep the model
// from inventing anything live in lib/recipeCheck.ts.
// ════════════════════════════════════════════════════════════════════════

import i18n from '../i18n';
import { callConfiguredProvider, repairTruncatedJson } from './llmParser.local';
import {
  buildCheckRequest, buildCheckSystemPrompt, interpretCheckResponse,
  type CheckCatalog, type CheckDraft, type CheckResult,
} from '../lib/recipeCheck';

function parseJsonObject(raw: string): any {
  const match = raw.match(/\{[\s\S]*\}/) ?? raw.match(/\{[\s\S]*/);
  if (!match) throw new Error(i18n.t('errors.noJsonFromModel'));
  try {
    return JSON.parse(match[0]);
  } catch {
    return JSON.parse(repairTruncatedJson(match[0]));
  }
}

export async function checkRecipeWithAi(draft: CheckDraft, catalog: CheckCatalog): Promise<CheckResult> {
  const request = buildCheckRequest(draft, catalog);
  const raw = await callConfiguredProvider(JSON.stringify(request), buildCheckSystemPrompt(catalog));
  return interpretCheckResponse(parseJsonObject(raw), draft, catalog);
}
