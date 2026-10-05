import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/app.store';
import { apiFetch, isNative } from '../lib/api';
import { useFileExport } from '../hooks/useFileExport';
import { slugForFilename } from '../lib/fileExport';
import { buildCookidooExport } from '../lib/cookidooExport';
import AddToCollectionPicker from './AddToCollectionPicker';
import ShareLinkModal from './ShareLinkModal';
import RecipeMergeModal from './RecipeMergeModal';

const ITEM = 'w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors flex items-center gap-2.5';

/** The gallery card's "…" menu: every action the recipe page offers, so a
 *  recipe can be filed, shared or cooked without opening it first.
 *
 *  Rendered through a portal and positioned `fixed`: the card is
 *  `overflow-hidden` (it clips the photo to its rounded corners), which would
 *  slice a popover off at the card's edge. */
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
  const { exportFile, sheet: exportSheet } = useFileExport();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'collection'>('menu');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const count = servings && servings > 0 ? servings : 4;
  const slug = slugForFilename(title);
  const native = isNative();

  useEffect(() => {
    if (!open) return;
    import('../lib/standalone').then(({ isStandaloneMode }) => isStandaloneMode()).then(setIsStandalone).catch(() => {});
    if (native) {
      import('../lib/offlineStore').then(({ isRecipeDownloaded }) => isRecipeDownloaded(recipeId)).then(setDownloaded).catch(() => {});
    }
  }, [open, native, recipeId]);

  // Anchor the panel under the button on wide screens, clamped to the
  // viewport; on a phone it becomes a bottom sheet (see className below).
  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 288;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 420));
    setPos({ top, left });
  }, [open, view]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => { setOpen(false); setView('menu'); };
  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2000);
  };

  const run = (fn: () => void | Promise<void>) => async () => {
    close();
    try {
      await fn();
    } catch (err) {
      console.error('Recipe action failed:', err);
    }
  };

  const loadFullRecipe = async () => {
    const res = await apiFetch(`/api/recipes/${recipeId}?lang=${encodeURIComponent(lang)}`);
    const json = await res.json();
    if (!res.ok) throw new Error('Recipe load failed');
    return json.data;
  };

  const exportJson = async () => {
    const res = await apiFetch(`/api/share/recipes/${recipeId}/export`);
    const json = await res.json();
    if (!res.ok) throw new Error(t('errors.exportFailed'));
    await exportFile({ fileName: `${slug}.smartchef.json`, mimeType: 'application/json', data: JSON.stringify(json.data, null, 2) });
  };

  const exportCookidoo = async () => {
    const recipe = await loadFullRecipe();
    const out = buildCookidooExport(recipe, {
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
    }, { servings: count });
    await exportFile({ fileName: `${slug}.cookidoo.txt`, mimeType: 'text/plain;charset=utf-8', data: out.fullText });
  };

  const toggleOffline = async () => {
    const { downloadRecipeOffline, removeDownloadedRecipe } = await import('../lib/offlineStore');
    if (downloaded) await removeDownloadedRecipe(recipeId);
    else await downloadRecipeOffline(await loadFullRecipe());
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
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); setView('menu'); }}
        aria-label={t('gallery.recipeActions')}
        title={t('gallery.recipeActions')}
        aria-expanded={open}
        className={`${btn} absolute z-20 ${dense ? 'top-2 right-2' : 'top-3 right-3'} rounded-full bg-white/90 dark:bg-zinc-900/90 text-zinc-700 dark:text-zinc-200 shadow-md flex items-center justify-center hover:bg-white active:scale-95 transition-all`}
      >
        <span className={`material-symbols-outlined ${dense ? 'text-[18px]' : 'text-[22px]'}`}>more_vert</span>
      </button>

      {notice && createPortal(
        <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-[70] px-4 py-2 rounded-full bg-zinc-900 text-white text-xs font-bold shadow-lg">{notice}</div>,
        document.body,
      )}

      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[60] max-sm:bg-black/30" onClick={close} />
          <div
            className="fixed z-[61] max-sm:inset-x-3 max-sm:bottom-3 sm:w-72 max-h-[75vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-100 dark:border-zinc-800 p-2"
            style={pos && window.innerWidth >= 640 ? { top: pos.top, left: pos.left } : undefined}
            onClick={(e) => e.stopPropagation()}
          >
            {view === 'collection' ? (
              <div className="p-1">
                <button type="button" onClick={() => setView('menu')} className="flex items-center gap-1 text-xs font-bold text-zinc-500 mb-1 px-1">
                  <span className="material-symbols-outlined text-[16px]">arrow_back</span>
                  {title}
                </button>
                <AddToCollectionPicker recipeId={recipeId} servings={count} />
              </div>
            ) : (
              <>
                <p className="px-3 pt-1 pb-1.5 text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest truncate">{title}</p>
                <button className={ITEM} onClick={run(() => navigate(`/recipe/${recipeId}?mode=edit`))}>
                  <span className="material-symbols-outlined text-[18px]">edit</span>{t('recipeDetail.editRecipeAria')}
                </button>
                <button className={ITEM} onClick={run(() => { addToShoppingCart({ recipeId, title, servings: count }); flash(t('gallery.addedToShoppingList')); })}>
                  <span className="material-symbols-outlined text-[18px]">shopping_cart</span>{t('recipeDetail.addToShoppingList')}
                </button>
                <button className={ITEM} onClick={() => setView('collection')}>
                  <span className="material-symbols-outlined text-[18px]">collections_bookmark</span>{t('recipeDetail.addToCollection')}
                </button>
                <button
                  className={ITEM}
                  onClick={run(async () => {
                    const res = await apiFetch(`/api/recipes/${recipeId}/cooked`, { method: 'POST' });
                    if (res.ok) flash(t('gallery.markedCooked'));
                  })}
                >
                  <span className="material-symbols-outlined text-[18px]">skillet</span>{t('recipeDetail.iCookedThis')}
                </button>
                <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
                <button className={ITEM} onClick={run(() => setShowShare(true))}>
                  <span className="material-symbols-outlined text-[18px]">link</span>{t('share.menuItem')}
                </button>
                <button className={ITEM} onClick={run(() => navigate(`/recipe/${recipeId}/report?servings=${count}&lang=${encodeURIComponent(lang)}`))}>
                  <span className="material-symbols-outlined text-[18px]">print</span>{t('print.report.menuItem')}
                </button>
                <button className={ITEM} onClick={run(exportJson)}>
                  <span className="material-symbols-outlined text-[18px]">data_object</span>{t('recipeDetail.exportAsJson')}
                </button>
                <button className={ITEM} onClick={run(exportCookidoo)}>
                  <span className="material-symbols-outlined text-[18px]">cooking</span>{t('recipeDetail.exportForCookidoo')}
                </button>
                {native && (
                  <button className={ITEM} onClick={run(toggleOffline)}>
                    <span className="material-symbols-outlined text-[18px]">{downloaded ? 'cloud_done' : 'download'}</span>{t('recipeDetail.downloadOffline')}
                  </button>
                )}
                {isStandalone && (
                  <button className={ITEM} onClick={run(() => setShowMerge(true))}>
                    <span className="material-symbols-outlined text-[18px]">merge</span>{t('recipeDetail.mergeTitle')}
                  </button>
                )}
                <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
                <button className={`${ITEM} !text-red-600`} onClick={run(remove)}>
                  <span className="material-symbols-outlined text-[18px]">delete</span>{t('recipeDetail.deleteRecipe')}
                </button>
              </>
            )}
          </div>
        </>,
        document.body,
      )}

      {showShare && (
        <ShareLinkModal
          open={showShare}
          onClose={() => setShowShare(false)}
          recipeId={recipeId}
          standalone={isStandalone}
          onExportFile={exportJson}
        />
      )}
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
      {exportSheet}
    </>
  );
}
