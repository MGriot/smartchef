import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
}

const RAW_TEXT_TEMPLATE = `Title:
Description:
Servings:
Prep time: [e.g. 20 minutes]
Cook time: [e.g. 45 minutes]
Difficulty: [easy / medium / hard / expert]
Tags: [comma-separated, e.g. vegetarian, quick, italian]

Ingredients:
- [quantity] [unit] [ingredient name] ([optional note, e.g. "finely chopped"])
- 200 g flour
- 2 eggs
- 1 tsp salt

Steps:
1. [First step]
2. [Second step]
3. `;

interface RecipeMatchResult {
  title: string;
  description?: string;
  servings: number;
  prepTimeMin?: number;
  cookTimeMin?: number;
  restTimeMin?: number;
  difficulty: string;
  tags: string[];
  sourceUrl?: string;
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
  const navigate = useNavigate();
  const contentLang = useStore((s) => s.contentLang);
  const [sourceType, setSourceType] = useState<'url' | 'text' | 'file'>('url');
  const [inputVal, setInputVal] = useState('');
  const [parsing, setParsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecipeMatchResult | null>(null);
  const [templateCopied, setTemplateCopied] = useState(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [importingFile, setImportingFile] = useState(false);
  const [fileResult, setFileResult] = useState<BundleImportResult | null>(null);

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
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Import failed');
      setResult(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
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
        sources: result.sourceUrl ? [{ type: 'url', label: 'Original recipe', url: result.sourceUrl }] : [],
        isComponent: false,
        // Best-effort default (the parser doesn't detect source language) —
        // the editor the user lands on right after creation makes this easy to fix.
        languageCode: contentLang || undefined,
        ingredients: result.matchedIngredients.map((ing, i) => ({
          sortOrder: i,
          ingredientId: ing.ingredientId,
          quantity: (typeof ing.quantity === 'number' && ing.quantity > 0) ? ing.quantity : undefined,
          quantityText: ing.quantityText || undefined,
          unitId: ing.unitId || undefined,
          notes: ing.notes || undefined,
          isOptional: false,
        })),
        steps: result.steps.map(s => ({
          stepNumber: s.stepNumber,
          title: s.title || undefined,
          description: s.description,
          durationMin: s.durationMin || undefined,
          toolIds: [],
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
      if (!res.ok) throw new Error(JSON.stringify(json.error || 'Failed to create recipe'));
      navigate(`/recipe/${json.data.id}?mode=edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create recipe');
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
        throw new Error('That file is not valid JSON.');
      }
      const res = await apiFetch('/api/share/recipes/import-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ? JSON.stringify(json.error) : 'Import failed');
      setFileResult(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportingFile(false);
    }
  };

  return (
    <AppLayout>
      <div className="p-12 max-w-6xl mx-auto">
          <div className="mb-12">
            <h1 className="text-6xl font-black text-zinc-900 tracking-tighter mb-4">Smart Import</h1>
            <p className="text-zinc-500 text-lg max-w-xl leading-relaxed">
              Paste a link or raw recipe notes. Our Culinary AI will transform it into a perfectly formatted masterpiece.
            </p>
          </div>

          <div className="grid grid-cols-12 gap-10">
            {/* Input Form */}
            <div className="col-span-12 lg:col-span-7">
              <div className="bg-white rounded-[40px] shadow-sm border border-zinc-100 overflow-hidden">
                <div className="p-8 border-b border-zinc-50 flex justify-between items-center">
                   <h3 className="text-[10px] font-black text-primary tracking-[0.2em] uppercase">Source Material</h3>
                   <div className="flex bg-zinc-100 p-1 rounded-xl">
                      <button
                        onClick={() => setSourceType('url')}
                        className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${sourceType === 'url' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-400'}`}
                      >URL</button>
                      <button
                         onClick={() => setSourceType('text')}
                         className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${sourceType === 'text' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-400'}`}
                      >Raw Text</button>
                      <button
                         onClick={() => setSourceType('file')}
                         className={`px-4 py-1.5 rounded-lg text-[10px] font-black transition-all ${sourceType === 'file' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-400'}`}
                      >Import File</button>
                   </div>
                </div>
                <div className="p-10">
                  {sourceType === 'file' ? (
                    <>
                      <p className="text-xs text-zinc-400 font-medium mb-4">
                        Import a <code className="bg-zinc-100 rounded px-1.5 py-0.5">.smartchef.json</code> file exported from another SmartChef instance — a single recipe, a bulk export, or a whole collection. Ingredients and tools it needs are matched against your library or created automatically.
                      </p>
                      <label className="flex flex-col items-center justify-center gap-3 w-full h-48 bg-zinc-50/50 rounded-3xl border-2 border-dashed border-zinc-200 cursor-pointer hover:border-primary/40 transition-colors">
                        <span className="material-symbols-outlined text-3xl text-zinc-300">upload_file</span>
                        <span className="text-sm font-bold text-zinc-500">
                          {selectedFile ? selectedFile.name : 'Choose a .smartchef.json file'}
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
                        {importingFile ? 'Importing…' : 'Import File'}
                      </button>
                      {error && (
                        <div className="mt-4 px-5 py-4 bg-red-50 border border-red-100 rounded-2xl text-sm text-red-600 font-medium">
                          {error}
                        </div>
                      )}
                      {fileResult && (
                        <div className="mt-8 bg-white rounded-3xl border border-zinc-100 p-8">
                          <div className="flex items-center gap-2 mb-4 text-primary">
                            <span className="material-symbols-outlined">check_circle</span>
                            <p className="font-black">
                              {fileResult.recipeIds.length} recipe{fileResult.recipeIds.length === 1 ? '' : 's'} imported
                            </p>
                          </div>
                          {fileResult.matchedIngredients.length > 0 && (
                            <>
                              <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">
                                Ingredients ({fileResult.matchedIngredients.length})
                              </p>
                              <div className="flex flex-wrap gap-2 mb-4">
                                {fileResult.matchedIngredients.map((ing, i) => (
                                  <span
                                    key={i}
                                    title={ing.isNew ? 'New ingredient created' : `Matched (${Math.round(ing.confidence * 100)}%)`}
                                    className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase flex items-center gap-1 ${ing.isNew ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 text-zinc-500'}`}
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
                              <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-2">
                                Tools ({fileResult.matchedTools.length})
                              </p>
                              <div className="flex flex-wrap gap-2 mb-4">
                                {fileResult.matchedTools.map((tool, i) => (
                                  <span
                                    key={i}
                                    title={tool.isNew ? 'New tool created' : 'Matched to existing tool'}
                                    className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase flex items-center gap-1 ${tool.isNew ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 text-zinc-500'}`}
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
                                <p key={i} className="text-[11px] text-zinc-400 leading-snug">{w}</p>
                              ))}
                            </div>
                          )}
                          <button
                            onClick={() => navigate(fileResult.recipeIds.length === 1 ? `/recipe/${fileResult.recipeIds[0]}?mode=edit` : '/')}
                            className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98]"
                          >
                            {fileResult.recipeIds.length === 1 ? 'Review Recipe' : 'Go to Gallery'}
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
                      className="w-full bg-zinc-50/50 rounded-2xl border-none focus:ring-2 focus:ring-primary/10 text-zinc-700 font-medium p-6"
                    />
                  ) : (
                    <>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs text-zinc-400 font-medium">
                          Not sure how to format it? Use the template — fill it in here, or copy it out to write the recipe elsewhere and paste it back later.
                        </p>
                        <div className="flex gap-2 shrink-0 ml-4">
                          <button
                            type="button"
                            onClick={copyTemplate}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-600 text-[11px] font-bold hover:bg-zinc-200 transition-colors whitespace-nowrap"
                          >
                            <span className="material-symbols-outlined text-[14px]">{templateCopied ? 'check' : 'content_copy'}</span>
                            {templateCopied ? 'Copied' : 'Copy Template'}
                          </button>
                          <button
                            type="button"
                            onClick={useTemplate}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 text-white text-[11px] font-bold hover:bg-zinc-800 transition-colors whitespace-nowrap"
                          >
                            <span className="material-symbols-outlined text-[14px]">description</span>
                            Use Template
                          </button>
                        </div>
                      </div>
                      <textarea
                        value={inputVal}
                        onChange={(e) => setInputVal(e.target.value)}
                        placeholder={"Mom's Famous Lasagna\nPrep time: 20 mins, Cook: 45 mins.\nServes 6.\n\nIngredients:\n- 1 lb ground beef..."}
                        className="w-full h-80 bg-zinc-50/50 rounded-3xl border-none focus:ring-2 focus:ring-primary/10 text-zinc-700 font-medium leading-relaxed resize-none p-6 hide-scrollbar"
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
                        {parsing ? 'Analyzing Recipe...' : 'Start AI Transformation'}
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
                 <div className="bg-white rounded-[40px] p-8 shadow-sm border border-zinc-100 text-center">
                    <span className="material-symbols-outlined text-4xl text-zinc-300 mb-3">auto_fix_high</span>
                    <p className="text-sm text-zinc-400 font-medium">Paste a recipe URL or raw text and start the transformation to see a preview here.</p>
                 </div>
               )}

               {parsing && (
                 <div className="bg-white rounded-[40px] p-8 shadow-sm border border-zinc-100 relative overflow-hidden group">
                    <div className="relative z-10 flex flex-col items-center text-center">
                       <div className="w-16 h-16 rounded-full bg-white shadow-xl flex items-center justify-center mb-6 relative">
                          <span className="material-symbols-outlined text-primary text-3xl animate-pulse">model_training</span>
                          <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping"></div>
                       </div>
                       <h3 className="text-2xl font-black text-zinc-900 mb-2">Culinary AI Active</h3>
                       <p className="text-primary font-bold text-xs tracking-tight">Fetching, analyzing ingredients & mapping steps...</p>
                       <p className="text-zinc-400 text-[11px] mt-2">This runs on a local model with no GPU acceleration — it can take several minutes.</p>
                    </div>
                 </div>
               )}

               {result && (
                 <div className="bg-white rounded-[40px] overflow-hidden shadow-xl shadow-zinc-200/50 border border-zinc-100">
                    <div className="p-8">
                       <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Preview</p>
                       <h4 className="text-2xl font-black text-zinc-900 leading-tight mb-6">{result.title}</h4>
                       <div className="flex gap-8 mb-6">
                          <div>
                             <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Servings</p>
                             <p className="text-sm font-black text-zinc-900 tracking-tight">{result.servings} People</p>
                          </div>
                          {result.prepTimeMin && (
                            <div>
                               <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Prep Time</p>
                               <p className="text-sm font-black text-zinc-900 tracking-tight">{result.prepTimeMin} Mins</p>
                            </div>
                          )}
                          {result.restTimeMin && (
                            <div>
                               <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Waiting Time</p>
                               <p className="text-sm font-black text-zinc-900 tracking-tight">{result.restTimeMin} Mins</p>
                            </div>
                          )}
                          <div>
                             <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-1">Confidence</p>
                             <p className="text-sm font-black text-zinc-900 tracking-tight">{Math.round(result.overallConfidence * 100)}%</p>
                          </div>
                       </div>
                       <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-3">
                         Ingredients ({result.matchedIngredients.length}) &middot; {result.steps.length} steps
                       </p>
                       <div className="flex flex-wrap gap-2 mb-6">
                          {result.matchedIngredients.map((ing, i) => (
                             <span
                                key={i}
                                title={ing.isNew ? 'New ingredient created' : `Matched (${Math.round(ing.confidence * 100)}%)`}
                                className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase flex items-center gap-1 ${ing.isNew ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 text-zinc-500'}`}
                             >
                                {ing.isNew && <span className="material-symbols-outlined text-[12px]">fiber_new</span>}
                                {ing.ingredientName}
                             </span>
                          ))}
                       </div>
                       {result.matchedTools.length > 0 && (
                         <>
                           <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest mb-3">
                             Tools ({result.matchedTools.length})
                           </p>
                           <div className="flex flex-wrap gap-2 mb-6">
                              {result.matchedTools.map((tool, i) => (
                                 <span
                                    key={i}
                                    title={tool.isNew ? 'New tool created' : 'Matched to existing tool'}
                                    className={`px-3 py-1 rounded-lg text-[10px] font-bold uppercase flex items-center gap-1 ${tool.isNew ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 text-zinc-500'}`}
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
                             <p key={i} className="text-[11px] text-zinc-400 leading-snug">{w}</p>
                           ))}
                         </div>
                       )}
                       <button
                         onClick={handleCreateRecipe}
                         disabled={creating}
                         className="w-full py-4 bg-primary text-white rounded-2xl font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
                       >
                         <span className="material-symbols-outlined text-lg">{creating ? 'sync' : 'check'}</span>
                         {creating ? 'Creating…' : 'Create & Review Recipe'}
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
