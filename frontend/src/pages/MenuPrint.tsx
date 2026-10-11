// ════════════════════════════════════════════════════════════════════════
// SmartChef — Menu print view
//
// The Planner's two kinds of menu on their own page, made for paper rather
// than the editor with its controls hidden (the same idea as
// pages/RecipeReport.tsx):
//   - an event menu is a centred menu card, one course after another, and a
//     day menu starts every further meal on a fresh sheet;
//   - a weekly plan is a grid — a column per day, a row per meal — printed
//     landscape so seven days fit across one sheet.
// What goes on the sheet is decided by lib/menuPrint.ts and lib/weekPrint.ts
// (pure, tested); this page fetches, lays out and prints through
// lib/print.ts, which knows how Android prints (the native plugin prints this
// very WebView, which is why this is a route and not a hidden iframe).
//
// Same constraints as the recipe report: the document scrolls, never an
// inner box; no <header>/<nav>/<footer>/<aside> in the sheet (index.css hides
// them on paper); photos would need .print-image (there are none here).
// ════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { apiFetch } from '../lib/api';
import { useStore } from '../store/app.store';
import { printPage, savePageAsPdf } from '../lib/print';
import { loadPaperSize, savePaperSize, sheetSize, usePageRule } from '../lib/paperSize';
import { buildMenuCard } from '../lib/menuPrint';
import { buildWeekSheet } from '../lib/weekPrint';
import type { EventMealType } from '../lib/eventMenu';
import { SHOW_NOTES_KEY } from '../components/planner/EventMenu';
import { menuKind, type MenuDetail, type RecipeOption } from '../components/planner/types';
import PrintToolbar from '../components/PrintToolbar';
import { SmartChefMenuMark, SmartChefWatermark } from '../components/SmartChefLogo';

export default function MenuPrint() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const contentLang = useStore((s) => s.contentLang);

  const [menu, setMenu] = useState<MenuDetail | null>(null);
  const [recipes, setRecipes] = useState<RecipeOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paper, setPaper] = useState(loadPaperSize);
  const [showNotes, setShowNotes] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_NOTES_KEY) !== '0'; } catch { return true; }
  });
  const [busy, setBusy] = useState<'print' | 'pdf' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedPdf, setSavedPdf] = useState<string | null>(null);

  const isWeek = !!menu && menuKind(menu) === 'week';
  const orientation = isWeek ? 'landscape' : 'portrait';
  usePageRule(paper, orientation);
  useEffect(() => { savePaperSize(paper); }, [paper]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setMenu(null);
    setLoadError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/menus/${id}`);
        const json = await res.json();
        if (!res.ok || !json.data) throw new Error(t('print.menu.loadFailed'));
        if (!cancelled) setMenu(json.data);
      } catch (err) {
        console.error('Menu print: fetch failed:', err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : t('print.menu.loadFailed'));
      }
    })();
    return () => { cancelled = true; };
  }, [id, t]);

  // Translated recipe titles, as the Planner shows them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/recipes${contentLang ? `?lang=${contentLang}` : ''}`);
        const json = await res.json();
        if (!cancelled) setRecipes(json.data || []);
      } catch (err) {
        console.error('Menu print: recipes fetch failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [contentLang]);

  const titleFor = (item: { recipeId: string; recipe_title: string }) => {
    const r = recipes.find((x) => x.id === item.recipeId);
    return r ? r.translated_title || r.title : item.recipe_title;
  };
  const mealName = (m: EventMealType) => t(`planner.mealTypes.${m}`);

  const card = useMemo(() => (menu && !isWeek
    ? buildMenuCard(menu, {
        showNotes,
        locale: i18n.language,
        mealName,
        otherDishesLabel: t('planner.event.otherDishes'),
        forGuestsLabel: (count) => t('planner.event.forGuests', { count }),
        titleFor,
      })
    : null), [menu, isWeek, showNotes, recipes, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const week = useMemo(() => (menu && isWeek
    ? buildWeekSheet({ ...menu, items: menu.items }, { locale: i18n.language, showNotes, mealName, titleFor })
    : null), [menu, isWeek, showNotes, recipes, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleNotes = (value: boolean) => {
    setShowNotes(value);
    try { localStorage.setItem(SHOW_NOTES_KEY, value ? '1' : '0'); } catch { /* ignore */ }
  };

  const handlePrint = async () => {
    if (!menu) return;
    setBusy('print');
    setActionError(null);
    try {
      await printPage(menu.name);
    } catch (err) {
      console.error('Menu print: print failed:', err);
      setActionError(t('print.report.printFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleSavePdf = async () => {
    if (!menu) return;
    setBusy('pdf');
    setActionError(null);
    setSavedPdf(null);
    try {
      const saved = await savePageAsPdf(menu.name, {
        footerLabel: `${menu.name} · SmartChef`,
        dialogTitle: t('print.report.savePdf'),
        pageSize: paper,
        landscape: isWeek,
      });
      if (saved) setSavedPdf(saved);
    } catch (err) {
      console.error('Menu print: PDF export failed:', err);
      setActionError(t('print.report.printFailed'));
    } finally {
      setBusy(null);
    }
  };

  /* ── The tab title seeds every "Save as PDF" filename ──────────── */
  useEffect(() => {
    if (!menu) return;
    const previous = document.title;
    document.title = menu.name;
    return () => { document.title = previous; };
  }, [menu?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const sheetWidth = `${sheetSize(paper, orientation).width}mm`;

  return (
    <div className="recipe-report-page min-h-screen bg-zinc-200 dark:bg-zinc-950">
      <PrintToolbar
        title={t(isWeek ? 'print.week.pageTitle' : 'print.menu.pageTitle')}
        onBack={() => (window.history.length > 1 ? navigate(-1) : navigate('/planner'))}
        paper={paper}
        onPaperChange={setPaper}
        maxWidth={sheetWidth}
        disabled={!menu || busy !== null}
        onPrint={handlePrint}
        onSavePdf={handleSavePdf}
        error={actionError}
        savedTo={savedPdf}
      >
        <label
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold cursor-pointer border transition-colors ${
            showNotes
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400'
          }`}
        >
          <input
            type="checkbox"
            className="accent-primary w-3.5 h-3.5"
            checked={showNotes}
            onChange={(e) => toggleNotes(e.target.checked)}
          />
          {t(isWeek ? 'print.week.showNotes' : 'print.menu.showNotes')}
        </label>
      </PrintToolbar>

      <div className="recipe-report-sheet-wrap px-0 sm:px-4 py-0 sm:py-8">
        {loadError ? (
          <p className="mx-auto p-8 text-sm text-red-600" style={{ maxWidth: sheetWidth }}>{loadError}</p>
        ) : !menu ? (
          <p className="mx-auto p-8 text-sm text-zinc-500 animate-pulse" style={{ maxWidth: sheetWidth }}>{t('common.loading')}</p>
        ) : card ? (
          <div
            className="print-sheet mx-auto bg-white text-zinc-900 shadow-xl sm:rounded-sm px-5 py-6 sm:px-[14mm] sm:py-[14mm]"
            style={{ maxWidth: sheetWidth }}
          >
            <div className="menu-card">
              <SmartChefMenuMark className="menu-card-logo" />
              {card.kicker && <p className="menu-card-kicker">{card.kicker}</p>}
              <h1 className="menu-card-title">{card.title}</h1>
              {card.intro && <p className="menu-card-intro">{card.intro}</p>}
              <div className="menu-card-rule" aria-hidden="true" />
              {card.sections.map((section, i) => (
                <section key={i} className={`menu-card-course${section.startsNewPage ? ' print-break-before' : ''}`}>
                  {section.mealHeading && <h2 className="menu-card-kicker menu-card-meal">{section.mealHeading}</h2>}
                  <h2 className="menu-card-course-name">{section.courseName}</h2>
                  {section.dishes.map((dish) => (
                    <div key={dish.id} className="menu-card-dish">
                      <p className="menu-card-dish-name">{dish.name}</p>
                      {dish.note && <p className="menu-card-dish-note">{dish.note}</p>}
                    </div>
                  ))}
                </section>
              ))}
              <div className="menu-card-rule" aria-hidden="true" />
              <p className="menu-card-footer">{card.footer}</p>
            </div>
          </div>
        ) : week ? (
          <div
            className="print-sheet week-sheet mx-auto bg-white text-zinc-900 shadow-xl sm:rounded-sm px-5 py-6 sm:px-[14mm] sm:py-[14mm]"
            style={{ maxWidth: sheetWidth }}
          >
            <div className="week-sheet-heading">
              <h1 className="week-sheet-title">{week.title}</h1>
              {week.weekStart && <p className="week-sheet-sub">{t('print.week.weekOf', { date: week.weekStart })}</p>}
              {week.notes && <p className="week-sheet-notes">{week.notes}</p>}
            </div>
            {week.empty ? (
              <p className="week-sheet-empty">{t('print.week.empty')}</p>
            ) : (
              <table className="week-table">
                <thead>
                  <tr>
                    <th className="week-meal-col" aria-hidden="true" />
                    {week.days.map((d) => (
                      <th key={d.idx}>
                        <span className="week-day-name">{d.label}</span>
                        {d.date && <span className="week-day-date">{d.date}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {week.rows.map((row) => (
                    <tr key={row.meal}>
                      <th scope="row" className="week-meal-col">{row.label}</th>
                      {row.cells.map((cell, di) => (
                        <td key={di}>
                          {cell.map((dish) => (
                            <div key={dish.id} className="week-dish">
                              <p className="week-dish-name">{dish.name}</p>
                              <p className="week-dish-servings">{t('planner.servingsCount', { count: dish.servings })}</p>
                              {dish.note && <p className="week-dish-note">{dish.note}</p>}
                            </div>
                          ))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-4 flex justify-center">
              <SmartChefWatermark />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
