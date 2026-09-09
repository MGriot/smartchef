import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { tryParseStructuredText, TemplateParseResult } from '../services/recipeTemplateParser';
import { extractRecipeFromHtml } from '../services/recipeStructuredData';
import { fetchPageHtml } from '../services/pageFetcher';
import { readMigrationFile, MIGRATION_SOURCE_LABELS, type MigrationResult } from '../services/migration/adapters';
import { planBulkImport, runBulkImport, type BulkPlan, type BulkProgress, type BulkImportSummary } from '../services/migration/bulkImport';
import { extractPdfText } from '../services/migration/pdfText';
import { readImageText, ocrLanguageFor, OCR_MODEL_MB, type OcrProgress } from '../services/migration/ocr';
import { proposeMatches, ProposedMatches } from '../services/matchSuggestions';
import { matchUnitId, type MatchSuggestion } from '../lib/fuzzyMatch';
import { repairIngredientAmount } from '../lib/ingredientAmount';

interface MatchedIngredient {
  ingredientId: string;
  ingredientName: string;
  confidence: number;
  isNew: boolean;
  unitId?: string;
  quantity?: number;
  quantityText?: string;
  notes?: string;
  groupName?: string | null;
}

interface MatchedTool {
  toolId: string;
  toolName: string;
  isNew: boolean;
}

interface BundleImportResult {
  recipeIds: string[];
  matchedIngredients: MatchedIngredient[];
  matchedTools: MatchedTool[];
  warnings: string[];
}

interface Category {
  id: string;
  name: string;
  translated_name?: string | null;
}

interface Unit {
  id: string;
  symbol: string;
  name: string;
}

// The Review Matches step's per-item resolution: either "use this existing
// library row" or "create a new one" (ingredients also need a category).
type Resolution = { choice: 'existing'; id: string; name: string } | { choice: 'new'; categoryId?: string };

function defaultResolution(suggestions: MatchSuggestion[]): Resolution {
  const top = suggestions[0];
  if (top && top.score > 0.7) return { choice: 'existing', id: top.id, name: top.name };
  return { choice: 'new' };
}

export default function RecipeImport() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const contentLang = useStore((s) => s.contentLang);
  const RAW_TEXT_TEMPLATE = t('import.rawTextTemplate');
  const JSON_TEMPLATE = t('import.rawTextTemplateJson');
  const [sourceType, setSourceType] = useState<'url' | 'text' | 'file' | 'scan'>('url');
  const [inputVal, setInputVal] = useState('');
  const [parsing, setParsing] = useState(false);
  const [matching, setMatching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateCopied, setTemplateCopied] = useState(false);
  const [templateFormat, setTemplateFormat] = useState<'text' | 'json'>('text');
  const [fetchingPage, setFetchingPage] = useState(false);
  const rawTextRef = React.useRef<HTMLTextAreaElement>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importingFile, setImportingFile] = useState(false);
  const [fileResult, setFileResult] = useState<BundleImportResult | null>(null);

  // Migration from another app: detected on file selection, so the button
  // can say what it is about to do before it does it.
  const [migration, setMigration] = useState<MigrationResult | null>(null);
  const [bulkPlan, setBulkPlan] = useState<BulkPlan | null>(null);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const [bulkSummary, setBulkSummary] = useState<BulkImportSummary | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanStage, setScanStage] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  // ── Parsed-but-not-yet-matched draft (from AI or the local parser), plus
  // the interactive Review Matches step's state ─────────────────────────
  const [draft, setDraft] = useState<TemplateParseResult | null>(null);
  const [suggestions, setSuggestions] = useState<ProposedMatches | null>(null);
  const [ingredientRes, setIngredientRes] = useState<Resolution[]>([]);
  const [toolRes, setToolRes] = useState<Resolution[]>([]);
  const [techniqueNames, setTechniqueNames] = useState<string[]>([]);
  const [techniqueRes, setTechniqueRes] = useState<Resolution[]>([]);
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [searchQuery, setSearchQuery] = useState<{ kind: 'ingredient' | 'tool' | 'technique'; index: number; query: string } | null>(null);
  const [searching, setSearching] = useState(false);

  // No real token-level progress signal is available without streaming the
  // LLM response over the wire, so this is honest indeterminate feedback:
  // an animated bar that eases toward ~90% (never claims to be "done" before
  // it actually is) plus an elapsed-time counter and rotating status text,
  // so a multi-minute CPU-inference wait doesn't look like a stalled spinner.
  useEffect(() => {
    if (!parsing) { setElapsedMs(0); return; }
    const start = Date.now();
    const interval = setInterval(() => setElapsedMs(Date.now() - start), 250);
    return () => clearInterval(interval);
  }, [parsing]);

  const PARSE_STATUS_MESSAGES = [
    t('import.status1'),
    t('import.status2'),
    t('import.status3'),
    t('import.status4'),
    t('import.status5'),
    t('import.status6'),
  ];
  const elapsedSec = elapsedMs / 1000;
  const parseProgressPct = Math.min(90, 90 * (1 - Math.exp(-elapsedSec / 45)));
  const parseStatusText = PARSE_STATUS_MESSAGES[Math.min(
    Math.floor(elapsedSec / 4),
    PARSE_STATUS_MESSAGES.length - 1
  )];
  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };

  // Grow the box to its content, in JS rather than CSS.
  //
  // The obvious `field-sizing: content` is inert in the desktop build —
  // Electron 25 is Chromium 114 and that property landed in 123 — which is
  // exactly where this was reported: a 25-line template opening in a fixed
  // 20rem box, showing about half of itself and reading as a partial
  // template rather than a scrolled one. Capped at 65vh, after which it
  // scrolls (with the themed scrollbar).
  useEffect(() => {
    const el = rawTextRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.65))}px`;
  }, [inputVal, sourceType]);

  const activeTemplate = templateFormat === 'json' ? JSON_TEMPLATE : RAW_TEXT_TEMPLATE;

  // Exactly the check handleStartImport() makes before deciding whether to
  // call the server at all (tryParseStructuredText → local parse, or the
  // LLM). Running it here as the user types is what lets the button below
  // stop calling itself an "AI transformation" for input the app parses
  // itself — the old label promised an LLM round-trip for pasted template
  // text that never touched one.
  const parsesLocally = useMemo(
    () => (sourceType === 'text' && inputVal.trim() ? tryParseStructuredText(inputVal) !== null : false),
    [sourceType, inputVal],
  );

  const useTemplate = () => {
    setSourceType('text');
    setInputVal(activeTemplate);
  };
  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(activeTemplate);
      setTemplateCopied(true);
      setTimeout(() => setTemplateCopied(false), 2000);
    } catch {
      // clipboard unavailable — user can still use the "Use Template" button
    }
  };

  const resetDraft = () => {
    setDraft(null);
    setSuggestions(null);
    setIngredientRes([]);
    setToolRes([]);
    setTechniqueNames([]);
    setTechniqueRes([]);
    setSearchQuery(null);
  };

  const loadCategoriesOnce = async (): Promise<Category[]> => {
    if (categories) return categories;
    try {
      const res = await apiFetch('/api/ingredients/categories');
      const json = await res.json();
      const cats: Category[] = json.data || [];
      setCategories(cats);
      return cats;
    } catch {
      setCategories([]);
      return [];
    }
  };

  // Runs the same matching step regardless of how `d` was produced (AI or
  // the local template/JSON parser) — the whole point of splitting parsing
  // from matching is that this step behaves identically either way.
  const beginReview = async (rawDraft: TemplateParseResult) => {
    // Repair badly-split amounts before anything else sees the draft.
    // This is the one place both producers meet (the local template parser
    // above and the AI response below), so the AI path — which is the one
    // that actually produced "quantity: 1, notes: '/2'" for "½ carota" in
    // this library — gets fixed here rather than needing the model to
    // behave. See lib/ingredientAmount.ts.
    const d: TemplateParseResult = {
      ...rawDraft,
      ingredients: rawDraft.ingredients.map((ing) => {
        const repaired = repairIngredientAmount(ing);
        return {
          ...ing,
          // The draft type uses `undefined` for "absent"; the repair helper
          // accepts either, so normalize on the way back in.
          quantity: repaired.quantity ?? undefined,
          notes: repaired.notes ?? undefined,
        };
      }),
    };
    setDraft(d);
    setMatching(true);
    setError(null);
    try {
      const ingredientNames = d.ingredients.map((i) => i.name);
      const toolNames = d.tools;
      const techNames = [...new Set(d.steps.flatMap((s) => s.techniques ?? []))];
      const matches = await proposeMatches(ingredientNames, toolNames, techNames);
      setSuggestions(matches);
      setIngredientRes(ingredientNames.map((n) => defaultResolution(matches.ingredients[n] || [])));
      setToolRes(toolNames.map((n) => defaultResolution(matches.tools[n] || [])));
      setTechniqueNames(techNames);
      setTechniqueRes(techNames.map((n) => defaultResolution(matches.techniques[n] || [])));
      if (ingredientNames.some((n) => defaultResolution(matches.ingredients[n] || []).choice === 'new')) {
        loadCategoriesOnce();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.importFailed'));
      resetDraft();
    } finally {
      setMatching(false);
    }
  };

  const handleStartImport = async () => {
    setError(null);
    resetDraft();
    if (sourceType === 'text') {
      const local = tryParseStructuredText(inputVal);
      if (local) {
        await beginReview(local);
        return;
      }
    }

    // Most recipe sites publish the recipe as schema.org JSON-LD for
    // Google's rich results. Reading that is instant and exact, so it runs
    // before the model — the LLM path below is for pages that carry none.
    //
    // Failures here are deliberately NOT fatal: an unreachable page, a bot
    // wall or a site with no structured data all just fall through to the
    // existing behaviour rather than turning a working import into an error.
    if (sourceType === 'url' && inputVal.trim()) {
      setFetchingPage(true);
      try {
        const html = await fetchPageHtml(inputVal.trim());
        const structured = extractRecipeFromHtml(html, inputVal.trim());
        if (structured) {
          setFetchingPage(false);
          await beginReview(structured);
          return;
        }
      } catch (err) {
        console.warn('Structured-data import unavailable, falling back to AI:', err);
      } finally {
        setFetchingPage(false);
      }
    }

    setParsing(true);
    try {
      const res = await apiFetch('/api/recipes/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: inputVal, inputType: sourceType }),
        // LLM parsing on CPU-only inference can take minutes — well above
        // apiFetch's default 10s native timeout. Backend itself allows up
        // to 600s for the Ollama call; stay just above that.
        timeoutMs: 650_000,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('import.importFailed'));
      await beginReview(json.data as TemplateParseResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.importFailed'));
    } finally {
      setParsing(false);
    }
  };

  const runSearch = async (kind: 'ingredient' | 'tool' | 'technique', query: string): Promise<MatchSuggestion[]> => {
    if (!query.trim()) return [];
    const path = kind === 'ingredient' ? '/api/ingredients' : kind === 'tool' ? '/api/tools' : '/api/techniques';
    const res = await apiFetch(`${path}?q=${encodeURIComponent(query)}`);
    const json = await res.json();
    const rows: Array<{ id: string; name: string; translated_name?: string | null }> = json.data || [];
    return rows.slice(0, 8).map((r) => ({ id: r.id, name: r.translated_name || r.name, score: 1 }));
  };

  const handleConfirmAndCreate = async () => {
    if (!draft) return;
    setCreating(true);
    setError(null);
    try {
      const unitsRes = await apiFetch('/api/units');
      const unitsJson = await unitsRes.json();
      const units: Unit[] = unitsJson.data || [];

      const matchedIngredients: MatchedIngredient[] = [];
      for (let i = 0; i < draft.ingredients.length; i++) {
        const ing = draft.ingredients[i];
        const resolution = ingredientRes[i];
        let ingredientId: string;
        let isNew = false;
        if (resolution?.choice === 'existing') {
          ingredientId = resolution.id;
        } else {
          const catId = resolution?.categoryId || (await loadCategoriesOnce())[0]?.id;
          if (!catId) throw new Error(`Pick a category for "${ing.name}"`);
          const createRes = await apiFetch('/api/ingredients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: ing.name, categoryId: catId }),
          });
          const createJson = await createRes.json();
          if (!createRes.ok) throw new Error(typeof createJson.error === 'string' ? createJson.error : `Could not create "${ing.name}"`);
          ingredientId = createJson.data.id;
          isNew = true;
        }
        matchedIngredients.push({
          ingredientId,
          ingredientName: resolution?.choice === 'existing' ? resolution.name : ing.name,
          confidence: resolution?.choice === 'existing' ? (suggestions?.ingredients[ing.name]?.find((s) => s.id === ingredientId)?.score ?? 1) : 1,
          isNew,
          unitId: matchUnitId(ing.unit, units),
          quantity: ing.quantity,
          quantityText: ing.quantityText,
          notes: ing.notes,
          groupName: ing.groupName ?? null,
        });
      }

      const matchedTools: MatchedTool[] = [];
      for (let i = 0; i < draft.tools.length; i++) {
        const name = draft.tools[i];
        const resolution = toolRes[i];
        let toolId: string;
        let isNew = false;
        if (resolution?.choice === 'existing') {
          toolId = resolution.id;
        } else {
          const createRes = await apiFetch('/api/tools', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          const createJson = await createRes.json();
          if (!createRes.ok) throw new Error(typeof createJson.error === 'string' ? createJson.error : `Could not create "${name}"`);
          toolId = createJson.data.id;
          isNew = true;
        }
        matchedTools.push({ toolId, toolName: resolution?.choice === 'existing' ? resolution.name : name, isNew });
      }

      const techniqueIdByName = new Map<string, string>();
      for (let i = 0; i < techniqueNames.length; i++) {
        const name = techniqueNames[i];
        const resolution = techniqueRes[i];
        let techniqueId: string;
        if (resolution?.choice === 'existing') {
          techniqueId = resolution.id;
        } else {
          const createRes = await apiFetch('/api/techniques', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          const createJson = await createRes.json();
          if (!createRes.ok) throw new Error(typeof createJson.error === 'string' ? createJson.error : `Could not create "${name}"`);
          techniqueId = createJson.data.id;
        }
        techniqueIdByName.set(name, techniqueId);
      }

      const payload = {
        title: draft.title,
        description: draft.description || undefined,
        difficulty: draft.difficulty || 'medium',
        servings: draft.servings || 4,
        prepTimeMin: draft.prepTimeMin || undefined,
        cookTimeMin: draft.cookTimeMin || undefined,
        restTimeMin: draft.restTimeMin || undefined,
        tags: draft.tags || [],
        // Only the structured-data path knows a cover image (schema.org
        // publishes one); the LLM path leaves it undefined.
        coverImageUrl: (draft as { imageUrl?: string }).imageUrl || undefined,
        sourceUrl: draft.sourceUrl || undefined,
        sources: draft.sourceUrl ? [{ type: 'url', label: t('import.originalRecipe'), url: draft.sourceUrl }] : [],
        isComponent: false,
        // Prefer the parsed recipe's own language over the current UI
        // language — someone browsing in English can still paste an
        // Italian recipe.
        languageCode: draft.language || contentLang || undefined,
        storageInstructions: draft.storageInstructions || undefined,
        tips: draft.tips || undefined,
        ingredients: matchedIngredients.map((ing, i) => ({
          sortOrder: i,
          ingredientId: ing.ingredientId,
          quantity: (typeof ing.quantity === 'number' && ing.quantity > 0) ? ing.quantity : undefined,
          quantityText: ing.quantityText || undefined,
          unitId: ing.unitId || undefined,
          notes: ing.notes || undefined,
          isOptional: false,
          groupName: ing.groupName || undefined,
        })),
        steps: draft.steps.map((s) => ({
          stepNumber: s.stepNumber,
          title: s.title || undefined,
          description: s.description,
          durationMin: s.durationMin || undefined,
          toolIds: [],
          techniqueIds: (s.techniques ?? []).map((n) => techniqueIdByName.get(n)).filter((id): id is string => !!id),
          stepIngredients: [],
        })),
        toolIds: matchedTools.map((t) => t.toolId),
      };
      const res = await apiFetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(json.error || t('import.failedToCreateRecipe')));
      navigate(`/recipe/${json.data.id}?mode=edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.failedToCreateRecipe'));
    } finally {
      setCreating(false);
    }
  };

  /** Reads the file just far enough to say which app it came from and how
   *  many recipes are in it. Silent on failure — an unrecognised file is
   *  simply not a migration, and the existing bundle importer still gets
   *  its turn when the button is pressed. */
  const detectMigration = async (file: File) => {
    setDetecting(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await readMigrationFile(file.name, bytes);
      setMigration(result);
      if (result) {
        setPlanning(true);
        try {
          setBulkPlan(await planBulkImport(result.recipes));
        } finally {
          setPlanning(false);
        }
      }
    } catch (err) {
      console.warn('Migration detection failed:', err);
      setMigration(null);
    } finally {
      setDetecting(false);
    }
  };

  /** A PDF's own text layer first, OCR only when there isn't one.
   *
   *  That order matters: a printed recipe saved as a PDF reads exactly and
   *  instantly, while OCR is slow, needs a model download and is markedly
   *  less accurate. Either way the extracted text lands in the raw-text box
   *  rather than importing straight off — OCR output always wants a human
   *  eye before it becomes a recipe. */
  const handleScan = async () => {
    if (!scanFile) return;
    setScanning(true);
    setError(null);
    setScanStage(null);
    try {
      const isPdf = scanFile.type === 'application/pdf' || /\.pdf$/i.test(scanFile.name);
      let extracted = '';

      if (isPdf) {
        setScanStage(t('import.scanReadingPdf'));
        const pdf = await extractPdfText(new Uint8Array(await scanFile.arrayBuffer()));
        if (pdf.hasTextLayer) {
          extracted = pdf.text;
        } else {
          // A scanned cookbook page is a PDF full of images: there is
          // nothing to read, and saying so beats importing an empty recipe.
          throw new Error(t('import.scanPdfNoText'));
        }
      } else {
        const onProgress = (p: OcrProgress) => {
          const pct = p.ratio === null ? '' : ` ${Math.round(p.ratio * 100)}%`;
          setScanStage((p.stage === 'loading' ? t('import.scanLoadingModel') : t('import.scanReading')) + pct);
        };
        extracted = await readImageText(scanFile, ocrLanguageFor(contentLang), onProgress);
      }

      if (!extracted.trim()) throw new Error(t('import.scanNothingFound'));

      // Hand it to the raw-text tab, which already knows how to turn prose
      // into a recipe (template parse first, then the model).
      setSourceType('text');
      setInputVal(extracted);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.importFailed'));
    } finally {
      setScanning(false);
      setScanStage(null);
    }
  };

  const handleBulkImport = async () => {
    if (!bulkPlan) return;
    setImportingFile(true);
    setError(null);
    setBulkSummary(null);
    try {
      const categoryId = await loadCategoriesOnce().then((cats) => cats?.[0]?.id);
      if (!categoryId) throw new Error(t('import.noCategory'));
      const unitsRes = await apiFetch('/api/units');
      const units = (await unitsRes.json()).data || [];
      const summary = await runBulkImport(bulkPlan, categoryId, units, setBulkProgress);
      setBulkSummary(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.importFailed'));
    } finally {
      setImportingFile(false);
      setBulkProgress(null);
    }
  };

  const handleImportFile = async () => {
    if (!selectedFile) return;
    setImportingFile(true);
    setError(null);
    setFileResult(null);
    try {
      const text = await selectedFile.text();
      let bundle: unknown;
      try {
        bundle = JSON.parse(text);
      } catch {
        throw new Error(t('import.notValidJson'));
      }
      const res = await apiFetch('/api/share/recipes/import-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
        timeoutMs: 120_000,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ? JSON.stringify(json.error) : t('import.importFailed'));
      setFileResult(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.importFailed'));
    } finally {
      setImportingFile(false);
    }
  };

  const renderResolutionRow = (
    kind: 'ingredient' | 'tool' | 'technique',
    index: number,
    name: string,
    sugs: MatchSuggestion[],
    resolution: Resolution | undefined,
    setResolution: (r: Resolution) => void,
    extra?: React.ReactNode
  ) => {
    const isSearching = searchQuery?.kind === kind && searchQuery.index === index;
    return (
      <div key={`${kind}-${index}`} className="rounded-2xl border border-zinc-100 dark:border-zinc-800 p-4 bg-zinc-50/50 dark:bg-zinc-900/50">
        <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200 mb-2">{name}</p>
        <div className="space-y-1.5">
          {sugs.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="radio"
                checked={resolution?.choice === 'existing' && resolution.id === s.id}
                onChange={() => setResolution({ choice: 'existing', id: s.id, name: s.name })}
              />
              <span className="text-zinc-700 dark:text-zinc-300">{s.name}</span>
              <span className="text-zinc-400 dark:text-zinc-500">({Math.round(s.score * 100)}%)</span>
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="radio"
              checked={resolution?.choice === 'new'}
              onChange={() => {
                setResolution({ choice: 'new' });
                if (kind === 'ingredient') loadCategoriesOnce();
              }}
            />
            <span className="text-amber-700 font-bold">{t('import.createNew', { name })}</span>
          </label>
          {resolution?.choice === 'new' && kind === 'ingredient' && (
            <select
              value={resolution.categoryId || ''}
              onChange={(e) => setResolution({ choice: 'new', categoryId: e.target.value })}
              className="mt-1 w-full text-xs bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1.5"
            >
              <option value="">{t('import.pickCategory')}</option>
              {(categories || []).map((c) => (
                <option key={c.id} value={c.id}>{c.translated_name || c.name}</option>
              ))}
            </select>
          )}
        </div>
        {!isSearching ? (
          <button
            type="button"
            onClick={() => setSearchQuery({ kind, index, query: '' })}
            className="mt-2 text-[11px] font-bold text-primary hover:underline"
          >
            {t('import.searchExisting')}
          </button>
        ) : (
          <div className="mt-2 flex gap-1.5">
            <input
              type="text"
              autoFocus
              value={searchQuery.query}
              onChange={(e) => setSearchQuery({ ...searchQuery, query: e.target.value })}
              placeholder={t('import.typeToSearchExisting')}
              className="flex-1 text-xs bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1.5"
            />
            <button
              type="button"
              disabled={searching}
              onClick={async () => {
                setSearching(true);
                try {
                  const results = await runSearch(kind, searchQuery.query);
                  if (results[0]) setResolution({ choice: 'existing', id: results[0].id, name: results[0].name });
                  // Merge fresh results to the top of the suggestion list so they're visible/selectable.
                  if (suggestions) {
                    const key = kind === 'ingredient' ? 'ingredients' : kind === 'tool' ? 'tools' : 'techniques';
                    setSuggestions({ ...suggestions, [key]: { ...suggestions[key], [name]: results } });
                  }
                } finally {
                  setSearching(false);
                  setSearchQuery(null);
                }
              }}
              className="px-3 py-1.5 rounded-lg bg-zinc-900 text-white text-[11px] font-bold"
            >
              {searching ? '…' : t('import.search')}
            </button>
          </div>
        )}
        {extra}
      </div>
    );
  };

  return (
    <AppLayout>
      <div className="p-6 sm:p-12 max-w-6xl mx-auto">
          <div className="mb-12">
            <h1 className="text-4xl sm:text-6xl font-black text-zinc-900 dark:text-zinc-100 tracking-tighter mb-4">{t('import.title')}</h1>
            <p className="text-zinc-500 dark:text-zinc-400 text-lg max-w-xl leading-relaxed">
              {t('import.subtitle')}
            </p>
          </div>

          <div className="grid grid-cols-12 gap-10">
            {/* Input Form */}
            <div className="col-span-12 lg:col-span-7">
              <div className="bg-white dark:bg-zinc-900 rounded-[40px] shadow-sm border border-zinc-100 dark:border-zinc-800 overflow-hidden">
                <div className="p-8 border-b border-zinc-50 dark:border-zinc-800 flex justify-between items-center">
                   <h3 className="text-[10px] font-black text-primary tracking-[0.2em] uppercase">{t('import.sourceMaterial')}</h3>
                   <div className="flex bg-zinc-100 dark:bg-zinc-800 p-1 rounded-xl">
                      <button
                        onClick={() => setSourceType('url')}
                        className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${sourceType === 'url' ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-400 dark:text-zinc-500'}`}
                      >{t('import.url')}</button>
                      <button
                         onClick={() => setSourceType('text')}
                         className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${sourceType === 'text' ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-400 dark:text-zinc-500'}`}
                      >{t('import.rawText')}</button>
                      <button
                         onClick={() => setSourceType('file')}
                         className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${sourceType === 'file' ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-400 dark:text-zinc-500'}`}
                      >{t('import.importFileTab')}</button>
                      <button
                         onClick={() => setSourceType('scan')}
                         className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${sourceType === 'scan' ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-400 dark:text-zinc-500'}`}
                      >{t('import.scanTab')}</button>
                   </div>
                </div>
                <div className="p-10">
                  {sourceType === 'scan' ? (
                    <>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium mb-4">
                        {t('import.scanHint')}
                      </p>
                      <label className="flex flex-col items-center justify-center gap-3 w-full h-48 bg-zinc-50/50 dark:bg-zinc-900/50 rounded-3xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 cursor-pointer hover:border-primary/40 transition-colors">
                        <span className="material-symbols-outlined text-3xl text-zinc-300 dark:text-zinc-600">document_scanner</span>
                        <span className="text-sm font-bold text-zinc-500 dark:text-zinc-400">
                          {scanFile ? scanFile.name : t('import.chooseScan')}
                        </span>
                        <input
                          type="file"
                          accept="image/*,application/pdf,.pdf"
                          className="hidden"
                          onChange={(e) => { setScanFile(e.target.files?.[0] ?? null); setError(null); }}
                        />
                      </label>

                      <p className="sc-hint mt-3">
                        {t('import.scanOcrCaveat', { mb: OCR_MODEL_MB })}
                      </p>

                      <button
                        onClick={handleScan}
                        disabled={scanning || !scanFile}
                        className="mt-8 w-full py-5 bg-primary text-white rounded-3xl font-black text-lg shadow-xl shadow-primary/20 flex items-center justify-center gap-3 hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-50 disabled:scale-100"
                      >
                        <span className={`material-symbols-outlined ${scanning ? 'animate-spin' : ''}`}>
                          {scanning ? 'settings' : 'document_scanner'}
                        </span>
                        {scanStage ?? (scanning ? t('import.scanning') : t('import.scanStart'))}
                      </button>
                    </>
                  ) : sourceType === 'file' ? (
                    <>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium mb-4">
                        {t('import.fileHintPrefix')} <code className="bg-zinc-100 dark:bg-zinc-800 rounded px-1.5 py-0.5">.smartchef.json</code> {t('import.fileHintSuffix')}
                      </p>
                      <label className="flex flex-col items-center justify-center gap-3 w-full h-48 bg-zinc-50/50 dark:bg-zinc-900/50 rounded-3xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 cursor-pointer hover:border-primary/40 transition-colors">
                        <span className="material-symbols-outlined text-3xl text-zinc-300 dark:text-zinc-600">upload_file</span>
                        <span className="text-sm font-bold text-zinc-500 dark:text-zinc-400">
                          {selectedFile ? selectedFile.name : t('import.chooseFile')}
                        </span>
                        <input
                          type="file"
                          accept=".json,.paprikarecipes,.paprikarecipe,.melarecipes,.crumb,.zip,.html,application/json"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0] ?? null;
                            setSelectedFile(file);
                            setFileResult(null);
                            setError(null);
                            setMigration(null);
                            setBulkPlan(null);
                            setBulkSummary(null);
                            if (file) void detectMigration(file);
                          }}
                        />
                      </label>
                      {/* ── Migration from another app ───────────────── */}
                      {detecting && (
                        <p className="mt-6 text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('import.detecting')}</p>
                      )}

                      {migration && bulkPlan && !bulkSummary && (
                        <div className="mt-6 sc-panel p-5 space-y-4">
                          <div className="flex items-start gap-3">
                            <span className="material-symbols-outlined text-primary">move_down</span>
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                                {t('import.migrationDetected', {
                                  app: MIGRATION_SOURCE_LABELS[migration.source],
                                  count: migration.recipes.length,
                                })}
                              </p>
                              <p className="sc-hint mt-1">
                                {t('import.migrationMatched', {
                                  matched: bulkPlan.ingredients.filter((d) => d.matchedId).length,
                                  total: bulkPlan.uniqueIngredientCount,
                                })}
                              </p>
                              {migration.skipped.length > 0 && (
                                <p className="sc-hint mt-1">
                                  {t('import.migrationSkipped', { count: migration.skipped.length })}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Only names the matcher was unsure about: a
                              confident match needs no decision, and a name
                              with no candidates at all is unambiguously new. */}
                          {bulkPlan.needsReview.length > 0 && (
                            <details className="rounded-xl bg-white dark:bg-zinc-900 p-3">
                              <summary className="cursor-pointer text-xs font-bold text-zinc-600 dark:text-zinc-300">
                                {t('import.migrationReview', { count: bulkPlan.needsReview.length })}
                              </summary>
                              <div className="mt-3 space-y-2 max-h-56 overflow-y-auto">
                                {bulkPlan.needsReview.map((d) => (
                                  <div key={d.name} className="flex items-center gap-2 text-xs">
                                    <span className="flex-1 min-w-0 truncate font-bold text-zinc-700 dark:text-zinc-300">{d.name}</span>
                                    <select
                                      value={d.matchedId ?? ''}
                                      onChange={(e) => {
                                        const id = e.target.value || null;
                                        const match = d.suggestions.find((sg) => sg.id === id);
                                        setBulkPlan({
                                          ...bulkPlan,
                                          ingredients: bulkPlan.ingredients.map((x) =>
                                            x.name === d.name ? { ...x, matchedId: id, matchedName: match?.name } : x,
                                          ),
                                          needsReview: bulkPlan.needsReview.map((x) =>
                                            x.name === d.name ? { ...x, matchedId: id, matchedName: match?.name } : x,
                                          ),
                                        });
                                      }}
                                      className="sc-field-inset w-48 shrink-0 text-xs"
                                    >
                                      <option value="">{t('import.migrationCreateNew')}</option>
                                      {d.suggestions.slice(0, 5).map((sg) => (
                                        <option key={sg.id} value={sg.id}>
                                          {sg.name} ({Math.round(sg.score * 100)}%)
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}

                          <button
                            onClick={handleBulkImport}
                            disabled={importingFile || planning}
                            className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50"
                          >
                            {bulkProgress
                              ? t('import.migrationProgress', { done: bulkProgress.done, total: bulkProgress.total })
                              : t('import.migrationImport', { count: migration.recipes.length })}
                          </button>
                          {bulkProgress && (
                            <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                              <div
                                className="h-full bg-primary transition-all duration-200"
                                style={{ width: `${bulkProgress.total ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%` }}
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {bulkSummary && (
                        <div className="mt-6 sc-panel p-5 space-y-3">
                          <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                            {t('import.migrationDone', { created: bulkSummary.created, ingredients: bulkSummary.newIngredients })}
                          </p>
                          {bulkSummary.failed.length > 0 && (
                            <details>
                              <summary className="cursor-pointer text-xs font-bold text-amber-600 dark:text-amber-500">
                                {t('import.migrationFailed', { count: bulkSummary.failed.length })}
                              </summary>
                              <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                                {bulkSummary.failed.map((f, i) => (
                                  <li key={i} className="sc-hint">{f.title} - {f.reason}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                          <button
                            onClick={() => navigate('/')}
                            className="w-full py-3 bg-primary text-white rounded-2xl font-black hover:bg-primary/90 transition-all"
                          >
                            {t('import.goToGallery')}
                          </button>
                        </div>
                      )}

                      <button
                        onClick={handleImportFile}
                        disabled={importingFile || !selectedFile || !!migration}
                        className="mt-8 w-full py-5 bg-gradient-to-r from-primary to-primary-container text-white rounded-3xl font-black text-lg shadow-xl shadow-primary/20 flex items-center justify-center gap-3 hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-50 disabled:scale-100"
                      >
                        <span className={`material-symbols-outlined ${importingFile ? 'animate-spin' : ''}`}>
                          {importingFile ? 'sync' : 'file_upload'}
                        </span>
                        {importingFile ? t('import.importing') : t('import.importFileTab')}
                      </button>
                      {error && (
                        <div className="mt-4 px-5 py-4 bg-red-50 border border-red-100 rounded-2xl text-sm text-red-600 font-medium">
                          {error}
                        </div>
                      )}
                      {fileResult && (
                        <div className="mt-8 bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-100 dark:border-zinc-800 p-8">
                          <div className="flex items-center gap-2 mb-4 text-primary">
                            <span className="material-symbols-outlined">check_circle</span>
                            <p className="font-black">
                              {t('import.recipesImported', { count: fileResult.recipeIds.length })}
                            </p>
                          </div>
                          {fileResult.matchedIngredients.length > 0 && (
                            <>
                              <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">
                                {t('import.ingredientsCount', { count: fileResult.matchedIngredients.length })}
                              </p>
                              <div className="flex flex-wrap gap-2 mb-4">
                                {fileResult.matchedIngredients.map((ing, i) => (
                                  <span
                                    key={i}
                                    title={ing.isNew ? t('import.newIngredientCreated') : t('import.matchedPercent', { percent: Math.round(ing.confidence * 100) })}
                                    className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase flex items-center gap-1 ${ing.isNew ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'}`}
                                  >
                                    {ing.isNew && <span className="material-symbols-outlined text-[12px]">fiber_new</span>}
                                    {ing.ingredientName}
                                  </span>
                                ))}
                              </div>
                            </>
                          )}
                          {fileResult.matchedTools.length > 0 && (
                            <>
                              <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-2">
                                {t('import.toolsCount', { count: fileResult.matchedTools.length })}
                              </p>
                              <div className="flex flex-wrap gap-2 mb-4">
                                {fileResult.matchedTools.map((tool, i) => (
                                  <span
                                    key={i}
                                    title={tool.isNew ? t('import.newToolCreated') : t('import.matchedToExistingTool')}
                                    className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase flex items-center gap-1 ${tool.isNew ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'}`}
                                  >
                                    {tool.isNew && <span className="material-symbols-outlined text-[12px]">fiber_new</span>}
                                    {tool.toolName}
                                  </span>
                                ))}
                              </div>
                            </>
                          )}
                          {fileResult.warnings.length > 0 && (
                            <div className="mb-4 space-y-1.5">
                              {fileResult.warnings.map((w, i) => (
                                <p key={i} className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-snug">{w}</p>
                              ))}
                            </div>
                          )}
                          <button
                            onClick={() => navigate(fileResult.recipeIds.length === 1 ? `/recipe/${fileResult.recipeIds[0]}?mode=edit` : '/')}
                            className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98]"
                          >
                            {fileResult.recipeIds.length === 1 ? t('import.reviewRecipe') : t('import.goToGallery')}
                          </button>
                        </div>
                      )}
                    </>
                  ) : sourceType === 'url' ? (
                    <input
                      type="url"
                      value={inputVal}
                      onChange={(e) => setInputVal(e.target.value)}
                      placeholder={t('import.urlPlaceholder')}
                      className="w-full bg-zinc-50/50 dark:bg-zinc-900/50 rounded-2xl border-none focus:ring-2 focus:ring-primary/10 text-zinc-700 dark:text-zinc-300 font-medium p-6"
                    />
                  ) : (
                    <>
                      {/* Stacked, not side-by-side: this card is ~700px at
                          its widest and the toolbar eats ~370px of it, which
                          left the explanation wrapping in a 300px ribbon. */}
                      <div className="flex flex-col gap-3 mb-3">
                        <div className="min-w-0">
                          <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium">
                            {t('import.notSureFormat')}
                          </p>
                          {templateFormat === 'json' && (
                            <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium mt-1">
                              {t('import.jsonTemplateHint')}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
                            {(['text', 'json'] as const).map((fmt) => (
                              <button
                                key={fmt}
                                type="button"
                                onClick={() => setTemplateFormat(fmt)}
                                className={`px-3 py-1 rounded-md text-[11px] font-bold transition-colors ${
                                  templateFormat === fmt
                                    ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                                    : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'
                                }`}
                              >
                                {fmt === 'json' ? t('import.templateFormatJson') : t('import.templateFormatText')}
                              </button>
                            ))}
                          </div>
                          <button
                            type="button"
                            onClick={copyTemplate}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 text-[11px] font-bold hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors whitespace-nowrap"
                          >
                            <span className="material-symbols-outlined text-[14px]">{templateCopied ? 'check' : 'content_copy'}</span>
                            {templateCopied ? t('import.copied') : t('import.copyTemplate')}
                          </button>
                          <button
                            type="button"
                            onClick={useTemplate}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 text-white text-[11px] font-bold hover:bg-zinc-800 transition-colors whitespace-nowrap"
                          >
                            <span className="material-symbols-outlined text-[14px]">description</span>
                            {t('import.useTemplate')}
                          </button>
                        </div>
                      </div>
                      <textarea
                        value={inputVal}
                        onChange={(e) => setInputVal(e.target.value)}
                        placeholder={t('import.rawTextPlaceholder')}
                        ref={rawTextRef}
                        spellCheck={false}
                        className="w-full min-h-[20rem] max-h-[65vh] overflow-y-auto bg-zinc-50/50 dark:bg-zinc-900/50 rounded-3xl border-none focus:ring-2 focus:ring-primary/10 text-zinc-700 dark:text-zinc-300 font-medium leading-relaxed resize-y p-6"
                      />
                    </>
                  )}
                  {sourceType !== 'file' && (
                    <>
                      {parsesLocally && (
                        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs font-bold text-primary">
                          <span className="material-symbols-outlined text-[16px]">bolt</span>
                          {t('import.noAiNeeded')}
                        </p>
                      )}
                      <button
                        onClick={handleStartImport}
                        disabled={parsing || matching || fetchingPage || !inputVal}
                        className={`w-full py-5 rounded-3xl font-black text-lg text-white shadow-xl shadow-primary/20 flex items-center justify-center gap-3 hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-50 disabled:scale-100 ${
                          parsesLocally ? 'mt-3 bg-primary' : 'mt-8 bg-gradient-to-r from-primary to-primary-container'
                        }`}
                      >
                        <span className={`material-symbols-outlined ${parsing || fetchingPage ? 'animate-spin' : ''}`}>
                          {parsing || fetchingPage ? 'settings' : parsesLocally ? 'bolt' : 'auto_fix_high'}
                        </span>
                        {fetchingPage
                          ? t('import.readingPage')
                          : parsing
                            ? t('import.analyzingRecipe')
                            : parsesLocally
                              ? t('import.importRecipe')
                              : t('import.startAiTransformation')}
                      </button>
                      {error && (
                        <div className="mt-4 px-5 py-4 bg-red-50 border border-red-100 rounded-2xl text-sm text-red-600 font-medium">
                          {error}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Sidebar: placeholder / parsing / Review Matches */}
            <div className="col-span-12 lg:col-span-5 space-y-8">
               {!draft && !parsing && !matching && (
                 <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-8 shadow-sm border border-zinc-100 dark:border-zinc-800 text-center">
                    <span className="material-symbols-outlined text-4xl text-zinc-300 dark:text-zinc-600 mb-3">auto_fix_high</span>
                    <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('import.pasteToPreview')}</p>
                 </div>
               )}

               {parsing && (
                 <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-8 shadow-sm border border-zinc-100 dark:border-zinc-800 relative overflow-hidden group">
                    <div className="relative z-10 flex flex-col items-center text-center">
                       <div className="w-16 h-16 rounded-full bg-white dark:bg-zinc-900 shadow-xl flex items-center justify-center mb-6 relative">
                          <span className="material-symbols-outlined text-primary text-3xl animate-pulse">model_training</span>
                          <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping"></div>
                       </div>
                       <h3 className="text-2xl font-black text-zinc-900 dark:text-zinc-100 mb-2">{t('import.culinaryAiActive')}</h3>
                       <p className="text-primary font-bold text-xs tracking-tight">{parseStatusText}</p>
                       <div className="w-full h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full mt-5 overflow-hidden">
                         <div
                           className="h-full bg-gradient-to-r from-primary to-primary-container rounded-full transition-all duration-500 ease-out"
                           style={{ width: `${parseProgressPct}%` }}
                         />
                       </div>
                       <p className="text-zinc-400 dark:text-zinc-500 text-[11px] mt-3 font-bold tabular-nums">{t('import.elapsed', { time: formatElapsed(elapsedMs) })}</p>
                       <p className="text-zinc-400 dark:text-zinc-500 text-[11px] mt-2">{t('import.localModelNote')}</p>
                    </div>
                 </div>
               )}

               {matching && (
                 <div className="bg-white dark:bg-zinc-900 rounded-[40px] p-8 shadow-sm border border-zinc-100 dark:border-zinc-800 text-center">
                    <span className="material-symbols-outlined text-3xl text-primary animate-spin mb-3">sync</span>
                    <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('import.findingMatches')}</p>
                 </div>
               )}

               {draft && !matching && (
                 <div className="bg-white dark:bg-zinc-900 rounded-[40px] overflow-hidden shadow-xl shadow-zinc-200/50 border border-zinc-100 dark:border-zinc-800">
                    <div className="p-8 max-h-[80vh] overflow-y-auto">
                       <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('import.reviewMatches')}</p>
                       <h4 className="text-2xl font-black text-zinc-900 dark:text-zinc-100 leading-tight mb-6">{draft.title || t('import.untitledRecipe')}</h4>

                       {draft.ingredients.length > 0 && (
                         <>
                           <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">{t('import.ingredientsCount', { count: draft.ingredients.length })}</p>
                           <div className="space-y-3 mb-6">
                             {draft.ingredients.map((ing, i) =>
                               renderResolutionRow(
                                 'ingredient', i, ing.name,
                                 suggestions?.ingredients[ing.name] || [],
                                 ingredientRes[i],
                                 (r) => setIngredientRes((prev) => prev.map((p, idx) => (idx === i ? r : p)))
                               )
                             )}
                           </div>
                         </>
                       )}

                       {draft.tools.length > 0 && (
                         <>
                           <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">{t('import.toolsCount', { count: draft.tools.length })}</p>
                           <div className="space-y-3 mb-6">
                             {draft.tools.map((name, i) =>
                               renderResolutionRow(
                                 'tool', i, name,
                                 suggestions?.tools[name] || [],
                                 toolRes[i],
                                 (r) => setToolRes((prev) => prev.map((p, idx) => (idx === i ? r : p)))
                               )
                             )}
                           </div>
                         </>
                       )}

                       {techniqueNames.length > 0 && (
                         <>
                           <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">{t('import.techniquesCount', { count: techniqueNames.length })}</p>
                           <div className="space-y-3 mb-6">
                             {techniqueNames.map((name, i) =>
                               renderResolutionRow(
                                 'technique', i, name,
                                 suggestions?.techniques[name] || [],
                                 techniqueRes[i],
                                 (r) => setTechniqueRes((prev) => prev.map((p, idx) => (idx === i ? r : p)))
                               )
                             )}
                           </div>
                         </>
                       )}

                       {draft.warnings.length > 0 && (
                         <div className="mb-6 space-y-1.5">
                           {draft.warnings.map((w, i) => (
                             <p key={i} className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-snug">{w}</p>
                           ))}
                         </div>
                       )}
                       {error && (
                         <div className="mb-4 px-5 py-4 bg-red-50 border border-red-100 rounded-2xl text-sm text-red-600 font-medium">
                           {error}
                         </div>
                       )}
                       <button
                         onClick={handleConfirmAndCreate}
                         disabled={creating}
                         className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
                       >
                         <span className="material-symbols-outlined text-lg">{creating ? 'sync' : 'check'}</span>
                         {creating ? t('recipeCreate.creating') : t('import.createAndReview')}
                       </button>
                    </div>
                 </div>
               )}
            </div>
          </div>
      </div>
    </AppLayout>
  );
}
