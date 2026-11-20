import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../lib/api';
import { useFileExport } from './useFileExport';
import { slugForFilename } from '../lib/fileExport';
import { buildCookidooExport, type CookidooExport, type CookidooRecipeInput } from '../lib/cookidooExport';
import ShareLinkModal from '../components/ShareLinkModal';
import CookidooExportModal from '../components/CookidooExportModal';
import { RecipeCookbookDialog } from '../components/sync/SharedCookbooks';
import type { ActionItem } from '../components/ActionMenu';

/** The recipe's "Export and share" actions — link, report, SmartChef file,
 *  shared cookbook, Cookidoo — with the dialogs they open. One copy for the
 *  recipe page and the gallery card, so the two menus offer the same things
 *  and each does the same thing in both (they used to drift: the card
 *  downloaded the Cookidoo text the page showed, and exported a different
 *  JSON in standalone mode).
 *
 *  `loadRecipe` gives the full recipe for Cookidoo: the page already has it,
 *  a card loads it on demand. */
export function useRecipeExportActions({
  recipeId,
  title,
  servings,
  lang,
  loadRecipe,
}: {
  recipeId: string;
  title: string;
  servings: number;
  lang?: string | null;
  loadRecipe: () => Promise<CookidooRecipeInput> | CookidooRecipeInput;
}): { items: ActionItem[]; dialogs: ReactNode; isStandalone: boolean; exportJson: () => Promise<void> } {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { exportFile, sheet } = useFileExport();
  const [isStandalone, setIsStandalone] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showCookbook, setShowCookbook] = useState(false);
  const [cookidoo, setCookidoo] = useState<CookidooExport | null>(null);
  const slug = slugForFilename(title);

  useEffect(() => {
    import('../lib/standalone').then(({ isStandaloneMode }) => isStandaloneMode()).then(setIsStandalone).catch(() => {});
  }, []);

  const exportJson = useCallback(async () => {
    // Standalone writes the share file another library can import
    // (services/recipeShare.local.ts); a server keeps its own bundle.
    const res = await apiFetch(`/api/share/recipes/${recipeId}/${isStandalone ? 'copy' : 'export'}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ? JSON.stringify(json.error) : t('errors.exportFailed'));
    await exportFile({ fileName: `${slug}.smartchef.json`, mimeType: 'application/json', data: JSON.stringify(json.data, null, 2) });
  }, [recipeId, isStandalone, slug, exportFile, t]);

  const openCookidoo = async () => {
    const recipe = await loadRecipe();
    setCookidoo(buildCookidooExport(recipe, {
      title: t('recipeDetail.cookidoo.fieldTitle'),
      prepTime: t('recipeDetail.cookidoo.fieldPrepTime'),
      totalTime: t('recipeDetail.cookidoo.fieldTotalTime'),
      servings: t('recipeDetail.cookidoo.fieldServings'),
      servingsValue: (n: number) => t('recipeDetail.cookidoo.portions', { count: n }),
      ingredients: t('recipeDetail.cookidoo.fieldIngredients'),
      steps: t('recipeDetail.cookidoo.fieldSteps'),
      devices: t('recipeDetail.cookidoo.fieldDevices'),
      tips: t('recipeDetail.cookidoo.fieldTips'),
      optional: t('recipeDetail.cookidoo.optional'),
      hourShort: t('recipeDetail.cookidoo.hourShort'),
      minuteShort: t('recipeDetail.cookidoo.minuteShort'),
      storagePrefix: t('recipeDetail.cookidoo.storagePrefix'),
      techniquesPrefix: t('recipeDetail.cookidoo.techniquesPrefix'),
    }, { servings }));
  };

  const items: ActionItem[] = [
    { key: 'share', icon: 'link', label: t('share.menuItem'), onSelect: () => setShowShare(true) },
    // A page of its own rather than this one printed: the report
    // (pages/RecipeReport.tsx) lays the recipe out for paper on every
    // platform, Android included.
    {
      key: 'report', icon: 'print', label: t('print.report.menuItem'),
      onSelect: () => {
        const query = new URLSearchParams({ servings: String(servings) });
        if (lang) query.set('lang', lang);
        navigate(`/recipe/${recipeId}/report?${query.toString()}`);
      },
    },
    { key: 'json', icon: 'data_object', label: t('recipeDetail.exportAsJson'), onSelect: exportJson },
    ...(isStandalone ? [{ key: 'cookbook', icon: 'menu_book', label: t('account.cookbooks.recipeMenuItem'), onSelect: () => setShowCookbook(true) }] : []),
    { key: 'cookidoo', icon: 'cooking', label: t('recipeDetail.exportForCookidoo'), onSelect: openCookidoo },
  ];

  const dialogs = (
    <>
      <ShareLinkModal
        open={showShare}
        onClose={() => setShowShare(false)}
        recipeId={recipeId}
        standalone={isStandalone}
        onExportFile={() => { void exportJson().catch((err) => console.error('Recipe export failed:', err)); }}
      />
      {isStandalone && <RecipeCookbookDialog open={showCookbook} onClose={() => setShowCookbook(false)} recipeId={recipeId} />}
      <CookidooExportModal
        data={cookidoo}
        onClose={() => setCookidoo(null)}
        onDownload={(text) => {
          exportFile({ fileName: `${slug}.cookidoo.txt`, mimeType: 'text/plain;charset=utf-8', data: text })
            .catch((err) => console.error('Recipe export failed:', err));
        }}
      />
      {sheet}
    </>
  );

  return { items, dialogs, isStandalone, exportJson };
}
