import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/app.store';
import { apiFetch, isNative } from '../lib/api';
import AddToCollectionPicker from './AddToCollectionPicker';
import RecipeMergeModal from './RecipeMergeModal';
import ActionMenu from './ActionMenu';
import { useRecipeExportActions } from '../hooks/useRecipeExportActions';

/** The gallery card's "…" menu: what the recipe page offers, so a recipe can
 *  be filed, shared or cooked without opening it first. Built on ActionMenu
 *  like the recipe page's own menus, and with the same export actions
 *  (useRecipeExportActions), so the two never offer different things:
 *  everyday actions first, the exports behind one "Export and share" entry,
 *  then merging and deleting. */
export default function RecipeCardMenu({
  recipeId,
  title,
  servings,
  lang,
  dense = false,
  onDeleted,
}: {
  recipeId: string;
  title: string;
  servings?: number;
  lang: string;
  dense?: boolean;
  onDeleted: (id: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const addToShoppingCart = useStore((s) => s.addToShoppingCart);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [inCollection, setInCollection] = useState(false);

  const count = servings && servings > 0 ? servings : 4;
  const native = isNative();

  const loadFullRecipe = async () => {
    const res = await apiFetch(`/api/recipes/${recipeId}?lang=${encodeURIComponent(lang)}`);
    const json = await res.json();
    if (!res.ok) throw new Error('Recipe load failed');
    return json.data;
  };

  const exportActions = useRecipeExportActions({ recipeId, title, servings: count, lang, loadRecipe: loadFullRecipe });

  useEffect(() => {
    if (!open || !native) return;
    import('../lib/offlineStore').then(({ isRecipeDownloaded }) => isRecipeDownloaded(recipeId)).then(setDownloaded).catch(() => {});
  }, [open, native, recipeId]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2000);
  };

  const toggleOffline = async () => {
    const { downloadRecipeOffline, removeDownloadedRecipe } = await import('../lib/offlineStore');
    if (downloaded) {
      await removeDownloadedRecipe(recipeId);
      setDownloaded(false);
    } else {
      await downloadRecipeOffline(await loadFullRecipe());
      setDownloaded(true);
      flash(t('recipeDetail.downloadedOffline'));
    }
  };

  const remove = async () => {
    if (!window.confirm(t('recipeDetail.deleteConfirm', { title }))) return;
    const res = await apiFetch(`/api/recipes/${recipeId}`, { method: 'DELETE' });
    if (res.ok || res.status === 204) onDeleted(recipeId);
  };

  const btn = dense ? 'w-7 h-7' : 'w-9 h-9';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={t('gallery.recipeActions')}
        title={t('gallery.recipeActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${btn} absolute z-20 ${dense ? 'top-2 right-2' : 'top-3 right-3'} rounded-full bg-white/90 dark:bg-zinc-900/90 text-zinc-700 dark:text-zinc-200 shadow-md flex items-center justify-center hover:bg-white active:scale-95 transition-all`}
      >
        <span className={`material-symbols-outlined ${dense ? 'text-[18px]' : 'text-[22px]'}`}>more_vert</span>
      </button>

      {notice && createPortal(
        <div role="status" className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[70] px-4 py-2 rounded-full bg-zinc-900 text-white text-xs font-bold shadow-lg">{notice}</div>,
        document.body,
      )}

      <ActionMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        title={title}
        label={t('gallery.recipeActions')}
        views={{
          main: {
            sections: [
              {
                label: t('recipeDetail.menu.sectionRecipe'),
                items: [
                  { key: 'edit', icon: 'edit', label: t('recipeDetail.editRecipeAria'), onSelect: () => navigate(`/recipe/${recipeId}?mode=edit`) },
                  {
                    key: 'shopping', icon: 'shopping_cart', label: t('recipeDetail.addToShoppingList'),
                    onSelect: () => { addToShoppingCart({ recipeId, title, servings: count }); flash(t('gallery.addedToShoppingList')); },
                  },
                  { key: 'collection', icon: 'collections_bookmark', label: t('recipeDetail.addToCollection'), view: 'collection', active: inCollection },
                  {
                    key: 'cooked', icon: 'skillet', label: t('recipeDetail.iCookedThis'),
                    onSelect: async () => {
                      const res = await apiFetch(`/api/recipes/${recipeId}/cooked`, { method: 'POST' });
                      if (res.ok) flash(t('gallery.markedCooked'));
                    },
                  },
                ],
              },
              {
                label: t('recipeDetail.menu.sectionShare'),
                items: [
                  { key: 'export', icon: 'ios_share', label: t('recipeDetail.menu.exportAndShare'), view: 'export' },
                  native && {
                    key: 'offline',
                    icon: downloaded ? 'download_done' : 'download',
                    label: downloaded ? t('recipeDetail.removeOfflineDownload') : t('recipeDetail.downloadOffline'),
                    active: downloaded,
                    onSelect: toggleOffline,
                  },
                ],
              },
              {
                label: t('recipeDetail.menu.sectionManage'),
                items: [
                  exportActions.isStandalone && { key: 'merge', icon: 'call_merge', label: t('recipeDetail.mergeTitle'), onSelect: () => setShowMerge(true) },
                  { key: 'delete', icon: 'delete', label: t('recipeDetail.deleteRecipe'), danger: true, onSelect: remove },
                ],
              },
            ],
          },
          export: { title: t('recipeDetail.menu.exportAndShare'), sections: [{ items: exportActions.items }] },
          collection: {
            // The picker has its own heading; the way back names the recipe.
            title,
            content: <AddToCollectionPicker recipeId={recipeId} servings={count} onMembershipChange={setInCollection} />,
          },
        }}
      />

      {exportActions.dialogs}
      {showMerge && (
        <RecipeMergeModal
          open={showMerge}
          onClose={() => setShowMerge(false)}
          recipeId={recipeId}
          recipeTitle={title}
          lang={lang}
          onMerged={(targetId) => { setShowMerge(false); navigate(`/recipe/${targetId}`); }}
        />
      )}
    </>
  );
}
