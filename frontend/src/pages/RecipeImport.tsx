import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';
import { tryParseStructuredText, TemplateParseResult } from '../services/recipeTemplateParser';
import { proposeMatches, ProposedMatches } from '../services/matchSuggestions';
import { matchUnitId, type MatchSuggestion } from '../lib/fuzzyMatch';

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
  const [sourceType, setSourceType] = useState<'url' | 'text' | 'file'>('url');
  const [inputVal, setInputVal] = useState('');
  const [parsing, setParsing] = useState(false);
  const [matching, setMatching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateCopied, setTemplateCopied] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importingFile, setImportingFile] = useState(false);
  const [fileResult, setFileResult] = useState<BundleImportResult | null>(null);

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

  const useTemplate = () => {
    setSourceType('text');
    setInputVal(RAW_TEXT_TEMPLATE);
  };
  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(RAW_TEXT_TEMPLATE);
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
  const beginReview = async (d: TemplateParseResult) => {
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
                   </div>
                </div>
                <div className="p-10">
                  {sourceType === 'file' ? (
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
                          accept=".json,application/json"
                          className="hidden"
                          onChange={(e) => { setSelectedFile(e.target.files?.[0] ?? null); setFileResult(null); setError(null); }}
                        />
                      </label>
                      <button
                        onClick={handleImportFile}
                        disabled={importingFile || !selectedFile}
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
                      placeholder="https://ricette.giallozafferano.it/..."
                      className="w-full bg-zinc-50/50 dark:bg-zinc-900/50 rounded-2xl border-none focus:ring-2 focus:ring-primary/10 text-zinc-700 dark:text-zinc-300 font-medium p-6"
                    />
                  ) : (
                    <>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium">
                          {t('import.notSureFormat')}
                        </p>
                        <div className="flex gap-2 shrink-0 ml-4">
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
                        className="w-full h-80 bg-zinc-50/50 dark:bg-zinc-900/50 rounded-3xl border-none focus:ring-2 focus:ring-primary/10 text-zinc-700 dark:text-zinc-300 font-medium leading-relaxed resize-none p-6 hide-scrollbar"
                      />
                    </>
                  )}
                  {sourceType !== 'file' && (
                    <>
                      <button
                        onClick={handleStartImport}
                        disabled={parsing || matching || !inputVal}
                        className="mt-8 w-full py-5 bg-gradient-to-r from-primary to-primary-container text-white rounded-3xl font-black text-lg shadow-xl shadow-primary/20 flex items-center justify-center gap-3 hover:scale-[1.01] active:scale-[0.99] transition-all disabled:opacity-50 disabled:scale-100"
                      >
                        <span className={`material-symbols-outlined ${parsing ? 'animate-spin' : ''}`}>
                          {parsing ? 'settings' : 'auto_fix_high'}
                        </span>
                        {parsing ? t('import.analyzingRecipe') : t('import.startAiTransformation')}
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
