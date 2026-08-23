import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

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

interface ParsedStep {
  stepNumber: number;
  title?: string;
  description: string;
  durationMin?: number;
  techniqueIds?: string[];
}

interface RecipeMatchResult {
  title: string;
  language?: string;
  description?: string;
  servings: number;
  prepTimeMin?: number;
  cookTimeMin?: number;
  restTimeMin?: number;
  difficulty: string;
  tags: string[];
  sourceUrl?: string;
  storageInstructions?: string | null;
  tips?: string | null;
  matchedIngredients: MatchedIngredient[];
  matchedTools: MatchedTool[];
  steps: ParsedStep[];
  overallConfidence: number;
  warnings: string[];
}

interface BundleImportResult {
  recipeIds: string[];
  matchedIngredients: MatchedIngredient[];
  matchedTools: MatchedTool[];
  warnings: string[];
}

export default function RecipeImport() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const contentLang = useStore((s) => s.contentLang);
  const RAW_TEXT_TEMPLATE = t('import.rawTextTemplate');
  const [sourceType, setSourceType] = useState<'url' | 'text' | 'file'>('url');
  const [inputVal, setInputVal] = useState('');
  const [parsing, setParsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecipeMatchResult | null>(null);
  const [templateCopied, setTemplateCopied] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importingFile, setImportingFile] = useState(false);
  const [fileResult, setFileResult] = useState<BundleImportResult | null>(null);

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

  const handleStartImport = async () => {
    setParsing(true);
    setError(null);
    setResult(null);
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
      setResult(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.importFailed'));
    } finally {
      setParsing(false);
    }
  };

  const handleCreateRecipe = async () => {
    if (!result) return;
    setCreating(true);
    setError(null);
    try {
      const payload = {
        title: result.title,
        description: result.description || undefined,
        difficulty: result.difficulty,
        servings: result.servings,
        prepTimeMin: result.prepTimeMin || undefined,
        cookTimeMin: result.cookTimeMin || undefined,
        restTimeMin: result.restTimeMin || undefined,
        tags: result.tags || [],
        sourceUrl: result.sourceUrl || undefined,
        sources: result.sourceUrl ? [{ type: 'url', label: t('import.originalRecipe'), url: result.sourceUrl }] : [],
        isComponent: false,
        // Prefer the LLM's own language detection over the current UI
        // language — someone browsing in English can still paste an
        // Italian URL, and the ingredient/tag data was already localized
        // against the detected language during matching.
        languageCode: result.language || contentLang || undefined,
        storageInstructions: result.storageInstructions || undefined,
        tips: result.tips || undefined,
        ingredients: result.matchedIngredients.map((ing, i) => ({
          sortOrder: i,
          ingredientId: ing.ingredientId,
          quantity: (typeof ing.quantity === 'number' && ing.quantity > 0) ? ing.quantity : undefined,
          quantityText: ing.quantityText || undefined,
          unitId: ing.unitId || undefined,
          notes: ing.notes || undefined,
          isOptional: false,
          groupName: ing.groupName || undefined,
        })),
        steps: result.steps.map(s => ({
          stepNumber: s.stepNumber,
          title: s.title || undefined,
          description: s.description,
          durationMin: s.durationMin || undefined,
          toolIds: [],
          techniqueIds: s.techniqueIds || [],
          stepIngredients: [],
        })),
        toolIds: result.matchedTools.map((t) => t.toolId),
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
                        disabled={parsing || !inputVal}
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

            {/* Sidebar Stats & Preview */}
            <div className="col-span-12 lg:col-span-5 space-y-8">
               {!result && !parsing && (
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

               {result && (
                 <div className="bg-white dark:bg-zinc-900 rounded-[40px] overflow-hidden shadow-xl shadow-zinc-200/50 border border-zinc-100 dark:border-zinc-800">
                    <div className="p-8">
                       <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('import.preview')}</p>
                       <h4 className="text-2xl font-black text-zinc-900 dark:text-zinc-100 leading-tight mb-6">{result.title}</h4>
                       <div className="flex gap-8 mb-6">
                          <div>
                             <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('recipeDetail.servings')}</p>
                             <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 tracking-tight">{t('import.peopleCount', { count: result.servings })}</p>
                          </div>
                          {result.prepTimeMin && (
                            <div>
                               <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('recipeDetail.prepTime')}</p>
                               <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 tracking-tight">{t('import.minsCount', { count: result.prepTimeMin })}</p>
                            </div>
                          )}
                          {result.restTimeMin && (
                            <div>
                               <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('recipeDetail.waitingTime')}</p>
                               <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 tracking-tight">{t('import.minsCount', { count: result.restTimeMin })}</p>
                            </div>
                          )}
                          <div>
                             <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-1">{t('import.confidence')}</p>
                             <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 tracking-tight">{Math.round(result.overallConfidence * 100)}%</p>
                          </div>
                       </div>
                       <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">
                         {t('import.ingredientsAndSteps', { ingCount: result.matchedIngredients.length, stepCount: result.steps.length })}
                       </p>
                       <div className="flex flex-wrap gap-2 mb-6">
                          {result.matchedIngredients.map((ing, i) => (
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
                       {result.matchedTools.length > 0 && (
                         <>
                           <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">
                             {t('import.toolsCount', { count: result.matchedTools.length })}
                           </p>
                           <div className="flex flex-wrap gap-2 mb-6">
                              {result.matchedTools.map((tool, i) => (
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
                       {result.warnings.length > 0 && (
                         <div className="mb-6 space-y-1.5">
                           {result.warnings.map((w, i) => (
                             <p key={i} className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-snug">{w}</p>
                           ))}
                         </div>
                       )}
                       <button
                         onClick={handleCreateRecipe}
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
