// ════════════════════════════════════════════════════════════════════════
// SmartChef — Shopping list print view
//
// The list on its own page, made for paper (same idea as
// pages/RecipeReport.tsx and pages/MenuPrint.tsx): aisles flow into two
// columns and no aisle is split across a column or a sheet, every row has a
// box to tick with a pen, and a list printed halfway through the shop can
// leave out what is already ticked. What goes on the sheet is decided by
// lib/shoppingPrint.ts (pure, tested).
// ════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../lib/api';
import { printPage, savePageAsPdf } from '../lib/print';
import { loadPaperSize, savePaperSize, sheetSize, usePageRule } from '../lib/paperSize';
import { buildShoppingSheet, type ShoppingListDetail, type ShoppingView } from '../lib/shoppingPrint';
import PrintToolbar from '../components/PrintToolbar';
import { SmartChefWatermark } from '../components/SmartChefLogo';

const OPTIONS_KEY = 'smartchef.shopping.printOptions';

function loadOptions(): { view: ShoppingView; uncheckedOnly: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}');
    return { view: raw.view === 'recipe' ? 'recipe' : 'ingredient', uncheckedOnly: !!raw.uncheckedOnly };
  } catch {
    return { view: 'ingredient', uncheckedOnly: false };
  }
}

export default function ShoppingPrint() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [list, setList] = useState<ShoppingListDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paper, setPaper] = useState(loadPaperSize);
  const [options, setOptions] = useState(loadOptions);
  const [busy, setBusy] = useState<'print' | 'pdf' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedPdf, setSavedPdf] = useState<string | null>(null);

  usePageRule(paper);
  useEffect(() => { savePaperSize(paper); }, [paper]);
  useEffect(() => {
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)); } catch { /* ignore */ }
  }, [options]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setList(null);
    setLoadError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/shopping/${id}`);
        const json = await res.json();
        if (!res.ok || !json.data) throw new Error(t('print.list.loadFailed'));
        if (!cancelled) setList(json.data);
      } catch (err) {
        console.error('Shopping print: fetch failed:', err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : t('print.list.loadFailed'));
      }
    })();
    return () => { cancelled = true; };
  }, [id, t]);

  const groups = useMemo(() => (list
    ? buildShoppingSheet(list, { ...options, otherAisleLabel: t('shopping.otherAisle'), t: (k) => t(k) })
    : []), [list, options, t]);

  const total = list?.items.length ?? 0;
  const remaining = list ? list.items.filter((i) => !i.isChecked).length : 0;

  useEffect(() => {
    if (!list) return;
    const previous = document.title;
    document.title = list.name;
    return () => { document.title = previous; };
  }, [list?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePrint = async () => {
    if (!list) return;
    setBusy('print');
    setActionError(null);
    try {
      await printPage(list.name);
    } catch (err) {
      console.error('Shopping print: print failed:', err);
      setActionError(t('print.report.printFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleSavePdf = async () => {
    if (!list) return;
    setBusy('pdf');
    setActionError(null);
    setSavedPdf(null);
    try {
      const saved = await savePageAsPdf(list.name, {
        footerLabel: `${list.name} · SmartChef`,
        dialogTitle: t('print.report.savePdf'),
        pageSize: paper,
      });
      if (saved) setSavedPdf(saved);
    } catch (err) {
      console.error('Shopping print: PDF export failed:', err);
      setActionError(t('print.report.printFailed'));
    } finally {
      setBusy(null);
    }
  };

  const sheetWidth = `${sheetSize(paper).width}mm`;

  return (
    <div className="recipe-report-page min-h-screen bg-zinc-200 dark:bg-zinc-950">
      <PrintToolbar
        title={t('print.list.pageTitle')}
        onBack={() => (window.history.length > 1 ? navigate(-1) : navigate('/shopping'))}
        paper={paper}
        onPaperChange={setPaper}
        maxWidth={sheetWidth}
        disabled={!list || busy !== null}
        onPrint={handlePrint}
        onSavePdf={handleSavePdf}
        error={actionError}
        savedTo={savedPdf}
      >
        <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
          {(['ingredient', 'recipe'] as const).map((view) => (
            <button
              key={view}
              type="button"
              onClick={() => setOptions((o) => ({ ...o, view }))}
              aria-pressed={options.view === view}
              className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition-colors ${
                options.view === view
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'
              }`}
            >
              {t(view === 'ingredient' ? 'shopping.byIngredient' : 'shopping.byRecipe')}
            </button>
          ))}
        </div>
        <label
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold cursor-pointer border transition-colors ${
            options.uncheckedOnly
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400'
          }`}
        >
          <input
            type="checkbox"
            className="accent-primary w-3.5 h-3.5"
            checked={options.uncheckedOnly}
            onChange={(e) => setOptions((o) => ({ ...o, uncheckedOnly: e.target.checked }))}
          />
          {t('print.uncheckedOnly')}
        </label>
      </PrintToolbar>

      <div className="recipe-report-sheet-wrap px-0 sm:px-4 py-0 sm:py-8">
        {loadError ? (
          <p className="mx-auto p-8 text-sm text-red-600" style={{ maxWidth: sheetWidth }}>{loadError}</p>
        ) : !list ? (
          <p className="mx-auto p-8 text-sm text-zinc-500 animate-pulse" style={{ maxWidth: sheetWidth }}>{t('common.loading')}</p>
        ) : (
          <div
            className="print-sheet shopping-sheet mx-auto bg-white text-zinc-900 shadow-xl sm:rounded-sm px-5 py-6 sm:px-[14mm] sm:py-[14mm]"
            style={{ maxWidth: sheetWidth }}
          >
            <h1 className="shopping-sheet-title">{list.name}</h1>
            <p className="shopping-sheet-sub">
              {t('print.printedFrom')} · {remaining}/{total}
            </p>

            {groups.length === 0 ? (
              <p className="shopping-sheet-empty">{t('print.list.empty')}</p>
            ) : (
              <div className="shopping-columns">
                {groups.map((group) => (
                  <section key={group.key} className="shopping-group">
                    <h2 className="shopping-group-title">{group.title}</h2>
                    <ul>
                      {group.rows.map((row) => (
                        <li key={row.id} className="shopping-row">
                          <span className="shopping-box" aria-hidden="true" />
                          <span className="shopping-row-main">
                            <span className={`shopping-row-name${row.checked ? ' shopping-row-done' : ''}`}>{row.name}</span>
                            {row.usedIn && <span className="shopping-row-for">{row.usedIn}</span>}
                          </span>
                          <span className="shopping-row-qty">{row.quantity}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}

            <div className="mt-6 flex justify-center">
              <SmartChefWatermark />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
