// ════════════════════════════════════════════════════════════════════════
// SmartChef — Recipe report (print / PDF)
//
// A page made for paper, not the recipe page with its controls hidden: the
// whole recipe on one flowing sheet — facts, every ingredient with its
// substitutes and notes, the equipment, each step with what it uses, its
// own tools, techniques and chef's note, then storage, tips, nutrition,
// references, and the full text of every recipe it uses as an ingredient.
//
// What goes on the sheet is decided by lib/recipeReport.ts (pure, tested);
// this page fetches, lays it out, and prints it through lib/print.ts, which
// knows how each platform prints — Android included, where window.print()
// is a silent no-op and the native plugin prints this very WebView.
//
// Two constraints shape the markup:
//   - The document scrolls, never an inner container. Every platform prints
//     the document; a page whose content lives in an overflow box prints
//     as one screenful.
//   - index.css's print rules hide <header>, <nav>, <footer> and <aside>
//     everywhere, and every <img> without .print-image — so the sheet uses
//     none of those elements, and its photos carry the class.
// ════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import i18n from '../i18n';
import { apiFetch } from '../lib/api';
import { canPrint, canSavePdfDirectly, printPage, savePageAsPdf } from '../lib/print';
import { isLocalImagePath, resolveImageSrc } from '../lib/localImages';
import { countryDisplayName, isCountryCode } from '../lib/countries';
import type { MeasurementSystem } from '../lib/unitConvert';
import {
  buildRecipeReport, missingComponentIds,
  type RecipeReportModel, type ReportInput, type ReportNamedInput, type ReportNutritionInput,
  type ReportOptions, type ReportRecipeInput, type ReportSection,
} from '../lib/recipeReport';
import RenderStepText from '../components/RenderStepText';
import { SOURCE_TYPE_META } from '../components/RecipeSourcesEditor';

type ToggleKey = 'includeCover' | 'includeStepPhotos' | 'includeComponents' | 'includeNutrition';
type Toggles = Record<ToggleKey, boolean>;

const OPTIONS_KEY = 'smartchef.report.options';
const DEFAULT_TOGGLES: Toggles = { includeCover: true, includeStepPhotos: true, includeComponents: true, includeNutrition: true };
/** How long Print waits on photos that never answer (a remote cover with no
 *  network) before letting the user print without them. */
const IMAGE_WAIT_MS = 8000;

function loadToggles(): Toggles {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) return { ...DEFAULT_TOGGLES, ...JSON.parse(raw) };
  } catch { /* private mode, bad JSON — defaults */ }
  return DEFAULT_TOGGLES;
}

function loadDisplaySystem(): MeasurementSystem {
  try {
    return (localStorage.getItem('smartchef.displaySystem') as MeasurementSystem) || 'metric';
  } catch {
    return 'metric';
  }
}

const isAndroidApp = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** Every stored image value the sheet will show, so they can be resolved
 *  (local paths need an async step) before anything is printed. */
function imageValues(model: RecipeReportModel): string[] {
  const values = new Set<string>();
  if (model.coverImage) values.add(model.coverImage);
  for (const section of [model.main, ...model.components]) {
    for (const step of section.steps) if (step.image) values.add(step.image);
  }
  return [...values];
}

export default function RecipeReport() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const lang = params.get('lang') || undefined;
  const langQuery = lang ? `?lang=${encodeURIComponent(lang)}` : '';

  const [recipe, setRecipe] = useState<ReportRecipeInput | null>(null);
  const [subRecipes, setSubRecipes] = useState<Map<string, ReportRecipeInput>>(new Map());
  const [componentsLoading, setComponentsLoading] = useState(false);
  const [techniques, setTechniques] = useState<ReportNamedInput[]>([]);
  const [nutrition, setNutrition] = useState<ReportNutritionInput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [servings, setServings] = useState<number | null>(() => {
    const n = Number(params.get('servings'));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  });
  const [displaySystem, setDisplaySystem] = useState<MeasurementSystem>(loadDisplaySystem);
  const [toggles, setToggles] = useState<Toggles>(loadToggles);

  const [resolvedImages, setResolvedImages] = useState<Map<string, string | null> | null>(null);
  const [settledImages, setSettledImages] = useState<Set<string>>(new Set());
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [imageWaitOver, setImageWaitOver] = useState(false);

  const [busy, setBusy] = useState<'print' | 'pdf' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedPdf, setSavedPdf] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(toggles)); } catch { /* ignore */ }
  }, [toggles]);
  useEffect(() => {
    try { localStorage.setItem('smartchef.displaySystem', displaySystem); } catch { /* ignore */ }
  }, [displaySystem]);

  /* ── The recipe itself ─────────────────────────────────────────── */
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setRecipe(null);
    setSubRecipes(new Map());
    setLoadError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/recipes/${id}${langQuery}`);
        const json = await res.json();
        if (!res.ok || !json.data) throw new Error(t('print.report.loadFailed'));
        if (cancelled) return;
        setRecipe(json.data);
        setServings(prev => prev ?? json.data.servings ?? 1);
      } catch (err) {
        console.error('Report: recipe fetch failed:', err);
        if (!cancelled) setLoadError(err instanceof Error ? err.message : t('print.report.loadFailed'));
      }
    })();
    return () => { cancelled = true; };
  }, [id, langQuery, t]);

  /* ── Technique names for {{tech:id}} references ────────────────── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/techniques${langQuery}`);
        const json = await res.json();
        if (!cancelled) setTechniques(json.data || []);
      } catch (err) { console.error('Report: techniques fetch failed:', err); }
    })();
    return () => { cancelled = true; };
  }, [langQuery]);

  /* ── Nutrition: at base servings, scaled by the builder. Standalone
     mode answers 501 (no nutrition engine on device) and the section is
     simply left out. ── */
  useEffect(() => {
    if (!id || !recipe) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/recipes/${id}/nutrition?servings=${recipe.servings}`);
        if (!res.ok) { if (!cancelled) setNutrition(null); return; }
        const json = await res.json();
        if (!cancelled) setNutrition(json.data || null);
      } catch {
        if (!cancelled) setNutrition(null);
      }
    })();
    return () => { cancelled = true; };
  }, [id, recipe]);

  /* ── Component recipes, walked as they arrive: a sub-recipe's own
     sub-recipes are only known once it has loaded. Each id is tried once;
     one that fails is printed as a plain ingredient row. ── */
  useEffect(() => {
    if (!recipe) return;
    let cancelled = false;
    const fetched = new Map<string, ReportRecipeInput>();
    const tried = new Set<string>();
    setComponentsLoading(true);
    (async () => {
      for (;;) {
        const batch = missingComponentIds(recipe, fetched).filter(subId => !tried.has(subId));
        if (batch.length === 0 || cancelled) break;
        batch.forEach(subId => tried.add(subId));
        const results = await Promise.all(batch.map(async subId => {
          try {
            const res = await apiFetch(`/api/recipes/${subId}${langQuery}`);
            const json = await res.json();
            return res.ok && json.data ? (json.data as ReportRecipeInput) : null;
          } catch (err) {
            console.error('Report: component recipe fetch failed:', subId, err);
            return null;
          }
        }));
        for (const sub of results) if (sub) fetched.set(sub.id, sub);
      }
      if (!cancelled) {
        setSubRecipes(new Map(fetched));
        setComponentsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [recipe, langQuery]);

  /* ── The sheet's content ───────────────────────────────────────── */
  const model = useMemo<RecipeReportModel | null>(() => {
    if (!recipe || servings == null) return null;
    const input: ReportInput = { recipe, subRecipes, techniques, nutrition };
    const options: ReportOptions = { servings, displaySystem, ...toggles };
    return buildRecipeReport(input, options, {
      t: (key, opts) => t(key, opts) as string,
      formatDate: iso => new Date(iso).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' }),
      // The name without the page's flag emoji: on Windows a flag prints as
      // its two code letters instead ("MA Morocco").
      formatRegion: r => (isCountryCode(r) ? countryDisplayName(r, i18n.language) : r),
    });
  }, [recipe, subRecipes, techniques, nutrition, servings, displaySystem, toggles, t]);

  /* ── The tab title seeds every "Save as PDF" filename ──────────── */
  useEffect(() => {
    if (!model) return;
    const previous = document.title;
    document.title = model.title;
    return () => { document.title = previous; };
  }, [model?.title]);

  /* ── Photos: resolved up front, then Print waits for every one to
     load or fail. A photo still loading when the print layout is taken
     prints as an empty box, and CoverImage's loading="lazy" (right for
     the gallery) can leave below-the-fold photos unloaded entirely. ── */
  // null until there is a sheet at all. An empty string would not do: a
  // recipe with no photos has the same '' before and after it loads, so the
  // effect would never run once it arrived and Print would stay disabled.
  const imageKey = model ? imageValues(model).join('\n') : null;
  useEffect(() => {
    if (imageKey === null || !model) return;
    let cancelled = false;
    const values = imageValues(model);
    setResolvedImages(null);
    setImageWaitOver(false);
    Promise.all(values.map(async v => {
      if (!isLocalImagePath(v)) return [v, v] as const;
      try { return [v, await resolveImageSrc(v)] as const; } catch { return [v, null] as const; }
    })).then(pairs => {
      if (!cancelled) setResolvedImages(new Map(pairs));
    });
    const timer = window.setTimeout(() => { if (!cancelled) setImageWaitOver(true); }, IMAGE_WAIT_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [imageKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const srcFor = (value: string | null): string | null => {
    if (!value || !resolvedImages) return null;
    const src = resolvedImages.get(value);
    return src && !failedImages.has(src) ? src : null;
  };
  const pendingImages = resolvedImages
    ? [...resolvedImages.values()].filter((src): src is string => !!src && !settledImages.has(src))
    : null;
  const imagesReady = imageWaitOver || (pendingImages !== null && pendingImages.length === 0);
  const ready = !!model && !componentsLoading && imagesReady;

  const onImageSettled = (src: string, failed: boolean) => {
    setSettledImages(prev => (prev.has(src) ? prev : new Set(prev).add(src)));
    if (failed) setFailedImages(prev => (prev.has(src) ? prev : new Set(prev).add(src)));
  };

  const reportImage = (value: string | null, className: string, alt = '') => {
    const src = srcFor(value);
    if (!src) return null;
    return (
      <img
        src={src}
        alt={alt}
        loading="eager"
        decoding="sync"
        className={`print-image ${className}`}
        onLoad={() => onImageSettled(src, false)}
        onError={() => onImageSettled(src, true)}
      />
    );
  };

  /* ── Actions ───────────────────────────────────────────────────── */
  const handlePrint = async () => {
    if (!model) return;
    setBusy('print');
    setActionError(null);
    try {
      await printPage(model.title);
    } catch (err) {
      console.error('Report: print failed:', err);
      setActionError(t('print.report.printFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleSavePdf = async () => {
    if (!model) return;
    setBusy('pdf');
    setActionError(null);
    setSavedPdf(null);
    try {
      const saved = await savePageAsPdf(model.title, {
        footerLabel: `${model.title} · SmartChef`,
        dialogTitle: t('print.report.savePdf'),
      });
      if (saved) setSavedPdf(saved);
    } catch (err) {
      console.error('Report: PDF export failed:', err);
      setActionError(t('print.report.printFailed'));
    } finally {
      setBusy(null);
    }
  };

  const setToggle = (key: ToggleKey, value: boolean) => setToggles(prev => ({ ...prev, [key]: value }));
  const hasStepPhotos = !!recipe && [recipe, ...subRecipes.values()].some(r => (r.steps || []).some(s => !!s.imageUrl));
  const hasComponents = !!recipe && (recipe.ingredients || []).some(i => !!i.subRecipeId);

  const printLabel = isAndroidApp() ? t('print.report.printOrSavePdf') : t('print.report.print');
  const printedOn = t('print.report.printedOn', {
    date: new Date().toLocaleDateString(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' }),
  });

  return (
    <div className="recipe-report-page min-h-screen bg-zinc-200 dark:bg-zinc-950">
      {/* ── Toolbar (screen only) ─────────────────────────────── */}
      <div
        className="no-print sticky top-0 z-30 bg-white/95 dark:bg-zinc-900/95 backdrop-blur border-b border-zinc-200 dark:border-zinc-800"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="max-w-[210mm] mx-auto px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-3">
          <button
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate(`/recipe/${id}`))}
            className="flex items-center gap-1 text-sm font-bold text-zinc-600 dark:text-zinc-300 hover:text-primary transition-colors"
            aria-label={t('common.back')}
          >
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            <span className="hidden sm:inline">{t('common.back')}</span>
          </button>
          <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 mr-auto">{t('print.report.pageTitle')}</p>

          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500">{t('recipeDetail.servings')}</span>
            <div className="flex items-center rounded-xl border border-zinc-200 dark:border-zinc-700">
              <button
                onClick={() => setServings(s => Math.max(1, (s ?? 1) - 1))}
                className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-primary"
                aria-label="−"
              >
                <span className="material-symbols-outlined text-[18px]">remove</span>
              </button>
              <span className="w-7 text-center text-sm font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{servings ?? '–'}</span>
              <button
                onClick={() => setServings(s => Math.min(99, (s ?? 1) + 1))}
                className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-primary"
                aria-label="+"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
              </button>
            </div>
          </div>

          <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
            {(['metric', 'imperial'] as const).map(sys => (
              <button
                key={sys}
                type="button"
                onClick={() => setDisplaySystem(sys)}
                className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition-colors ${
                  displaySystem === sys
                    ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                    : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'
                }`}
              >
                {t(`converter.${sys}`)}
              </button>
            ))}
          </div>

          <div className="w-full flex flex-wrap items-center gap-2">
            {([
              ['includeCover', t('print.report.includeCover'), !!recipe?.cover_image_url],
              ['includeStepPhotos', t('print.report.includeStepPhotos'), hasStepPhotos],
              ['includeComponents', t('print.report.includeComponents'), hasComponents],
              ['includeNutrition', t('print.report.includeNutrition'), !!nutrition],
            ] as const).filter(([, , available]) => available).map(([key, label]) => (
              <label
                key={key}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold cursor-pointer border transition-colors ${
                  toggles[key]
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-primary w-3.5 h-3.5"
                  checked={toggles[key]}
                  onChange={e => setToggle(key, e.target.checked)}
                />
                {label}
              </label>
            ))}

            <div className="ml-auto flex items-center gap-2">
              {!ready && model && (
                <span className="text-xs text-zinc-400 dark:text-zinc-500 animate-pulse">{t('print.report.preparing')}</span>
              )}
              {canSavePdfDirectly() && (
                <button
                  onClick={handleSavePdf}
                  disabled={!ready || busy !== null}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold text-zinc-700 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">picture_as_pdf</span>
                  {t('print.report.savePdf')}
                </button>
              )}
              {canPrint() && (
                <button
                  onClick={handlePrint}
                  disabled={!ready || busy !== null}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold text-white bg-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
                >
                  <span className="material-symbols-outlined text-[18px]">print</span>
                  {printLabel}
                </button>
              )}
            </div>
          </div>
          {(actionError || savedPdf) && (
            <p className={`w-full text-xs ${actionError ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'} break-all`}>
              {actionError || t('print.report.savedTo', { location: savedPdf })}
            </p>
          )}
        </div>
      </div>

      {/* ── The sheet ─────────────────────────────────────────── */}
      <div className="recipe-report-sheet-wrap px-0 sm:px-4 py-0 sm:py-8">
        {loadError ? (
          <p className="max-w-[210mm] mx-auto p-8 text-sm text-red-600">{loadError}</p>
        ) : !model ? (
          <p className="max-w-[210mm] mx-auto p-8 text-sm text-zinc-500 animate-pulse">{t('common.loading')}</p>
        ) : (
          <div className="recipe-report max-w-[210mm] mx-auto bg-white text-zinc-900 shadow-xl sm:rounded-sm px-5 py-6 sm:px-[16mm] sm:py-[14mm]">
            {/* Title block */}
            <div className="report-keep flex flex-col-reverse sm:flex-row gap-5 items-start">
              <div className="flex-1 min-w-0">
                <h1 className="font-headline text-[26px] leading-tight font-extrabold">{model.title}</h1>
                {model.description && <p className="mt-2 text-[13px] leading-relaxed text-zinc-700">{model.description}</p>}
                {model.meta.length > 0 && (
                  <p className="mt-2 text-[11px] text-zinc-500">{model.meta.join('  ·  ')}</p>
                )}
                {model.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {model.tags.map((tag, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider"
                        style={{ borderColor: tag.color || '#a1a1aa', color: tag.color || '#52525b' }}
                      >
                        {tag.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {reportImage(model.coverImage, 'w-full sm:w-44 h-48 sm:h-44 object-cover rounded-lg shrink-0', model.title)}
            </div>

            <FactsGrid facts={model.facts} />
            {model.regions.length > 0 && (
              <p className="mt-3 text-[12px] text-zinc-600">
                <span className="font-bold text-zinc-800">{t('recipeDetail.regions')}:</span> {model.regions.join(', ')}
              </p>
            )}

            <SectionBody section={model.main} reportImage={reportImage} />

            {model.nutrition && (
              <div className="report-keep mt-8">
                <h2 className="report-h2">{t('recipeDetail.nutrition')}</h2>
                <p className="text-[11px] text-zinc-500 mb-2">{model.nutrition.heading}</p>
                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-[12px]">
                  {model.nutrition.rows.map(row => (
                    <div key={row.label} className="flex justify-between border-b border-dotted border-zinc-300 py-0.5">
                      <dt className="text-zinc-600">{row.label}</dt>
                      <dd className="font-bold tabular-nums">{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-[11px] text-zinc-500 mt-2">{model.nutrition.perServing}</p>
                {model.nutrition.unresolved && <p className="text-[10px] text-zinc-500 italic mt-1">{model.nutrition.unresolved}</p>}
              </div>
            )}

            {model.references.length > 0 && (
              <div className="report-keep mt-8">
                <h2 className="report-h2">{t('recipeDetail.references')}</h2>
                <ul className="space-y-1 text-[12px]">
                  {model.references.map((ref, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="font-bold text-zinc-500 shrink-0">{t((SOURCE_TYPE_META[ref.type] || SOURCE_TYPE_META.other).labelKey)}:</span>
                      <span className="min-w-0 break-words">
                        {ref.label}
                        {ref.url && ref.url !== ref.label && <span className="text-zinc-500"> — {ref.url}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {model.components.length > 0 && (
              <div className="mt-10 print-break-before">
                <h2 className="report-h2 text-[18px]">{t('print.report.componentsHeading')}</h2>
                {model.components.map((section, idx) => (
                  <div key={section.id} id={section.anchor} className={`${idx > 0 ? 'mt-10 pt-6 border-t border-zinc-300' : 'mt-2'}`}>
                    <h3 className="font-headline text-[20px] font-extrabold leading-tight report-heading">{section.title}</h3>
                    {section.usedIn.length > 0 && (
                      <p className="mt-1 text-[11px] font-bold text-zinc-500 uppercase tracking-wider">{section.usedIn.join(' · ')}</p>
                    )}
                    {section.description && <p className="mt-2 text-[12px] text-zinc-700">{section.description}</p>}
                    <FactsGrid facts={section.facts} />
                    <SectionBody section={section} reportImage={reportImage} compact />
                  </div>
                ))}
              </div>
            )}

            <p className="mt-10 pt-3 border-t border-zinc-200 text-[10px] text-zinc-400 flex justify-between gap-4">
              <span>{printedOn}</span>
              <span className="text-right">{t('print.report.servingsNote', { count: servings ?? 1 })}</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Pieces ─────────────────────────────────────────────────────── */

function FactsGrid({ facts }: { facts: RecipeReportModel['facts'] }) {
  if (facts.length === 0) return null;
  return (
    // auto-fit rather than a fixed column count: a recipe with two facts
    // would otherwise print four empty cells beside them.
    <dl
      className="report-keep mt-5 grid border border-zinc-300 rounded-lg overflow-hidden"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))' }}
    >
      {facts.map((fact, i) => (
        <div key={i} className="px-3 py-2 border-zinc-300 border-r border-b -mr-px -mb-px">
          <dt className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">{fact.label}</dt>
          <dd className="text-[13px] font-bold font-headline">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SectionBody({ section, reportImage, compact = false }: {
  section: ReportSection;
  reportImage: (value: string | null, className: string, alt?: string) => JSX.Element | null;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const H = compact ? 'h4' : 'h2';
  const headingClass = compact ? 'report-h3' : 'report-h2';
  return (
    <>
      {section.ingredientGroups.length > 0 && (
        <div className="mt-8">
          <H className={headingClass}>{t('recipeDetail.ingredients')}</H>
          <div className="report-columns">
            {section.ingredientGroups.map((group, gi) => (
              <div key={gi} className="report-ingredient-group">
                {group.name && <p className="report-group-name">{group.name}</p>}
                <ul>
                  {group.items.map((ing, i) => (
                    <li key={i} className="report-ingredient">
                      <span className="report-box" aria-hidden="true" />
                      <span className="report-amount">{ing.amount}</span>
                      <span className="report-name">
                        <span className={ing.componentAnchor ? 'font-bold' : undefined}>{ing.name}</span>
                        {ing.optional && <span className="report-optional">{t('recipeDetail.optional')}</span>}
                        {ing.note && <span className="report-note"> — {ing.note}</span>}
                        {ing.componentAnchor && (
                          <a href={`#${ing.componentAnchor}`} className="report-see">→ {t('print.report.seeBelow')}</a>
                        )}
                        {ing.substitutes.map((alt, ai) => (
                          <span key={ai} className="report-substitute">
                            {t('recipeDetail.orInstead')} {alt.amount ? `${alt.amount} ` : ''}{alt.name}
                            {alt.note ? ` — ${alt.note}` : ''}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {(section.tools.length > 0 || section.techniques.length > 0) && (
        <div className="report-keep mt-6 text-[12px] space-y-1">
          <H className={headingClass}>{t('recipeDetail.equipment')}</H>
          {section.tools.length > 0 && (
            <p><span className="font-bold">{t('recipeDetail.kitchenTools')}:</span> {section.tools.join(', ')}</p>
          )}
          {section.techniques.length > 0 && (
            <p><span className="font-bold">{t('recipeDetail.techniques')}:</span> {section.techniques.join(', ')}</p>
          )}
        </div>
      )}

      {section.steps.length > 0 && (
        <div className="mt-8">
          <H className={headingClass}>{t('recipeDetail.theMethod')}</H>
          <ol className="space-y-5">
            {section.steps.map((step, idx) => (
              <li key={step.key} className="report-step flex gap-4">
                <span className="report-step-number">{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-headline font-bold text-[14px] leading-snug">
                    {step.title}
                    {step.duration && <span className="ml-2 text-[11px] font-semibold text-zinc-500">⏱ {step.duration}</span>}
                  </p>
                  {reportImage(step.image, 'mt-2 w-full max-h-[60mm] object-cover rounded-md')}
                  <p className="report-step-text mt-1.5 text-[12.5px] leading-relaxed text-zinc-800 whitespace-pre-line">
                    <RenderStepText
                      text={step.text}
                      ingredients={step.textContext.ingredients}
                      tools={step.textContext.tools}
                      techniques={step.textContext.techniques}
                      scale={step.textContext.scale}
                    />
                  </p>
                  {step.uses.length > 0 && (
                    <p className="mt-1.5 text-[11px] text-zinc-600">
                      <span className="font-bold">{t('recipeDetail.ingredients')}:</span> {step.uses.join(' · ')}
                    </p>
                  )}
                  {(step.tools.length > 0 || step.techniques.length > 0) && (
                    <p className="mt-0.5 text-[11px] text-zinc-600">
                      <span className="font-bold">{t('recipeDetail.equipment')}:</span> {[...step.tools, ...step.techniques].join(' · ')}
                    </p>
                  )}
                  {step.note && (
                    <p className="report-chef-note mt-2 text-[11.5px] italic text-zinc-700">
                      <span className="not-italic font-bold">{t('recipeDetail.chefsNote')}:</span> {step.note}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(section.storage || section.tips) && (
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-6">
          {section.storage && (
            <div className="report-keep">
              <H className={headingClass}>{t('recipeDetail.storageInstructions')}</H>
              <p className="text-[12px] leading-relaxed whitespace-pre-wrap">{section.storage}</p>
            </div>
          )}
          {section.tips && (
            <div className="report-keep">
              <H className={headingClass}>{t('recipeDetail.tips')}</H>
              <p className="text-[12px] leading-relaxed whitespace-pre-wrap">{section.tips}</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
