import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/app.store';
import { SUPPORTED_LANGUAGES } from '../i18n';
import RenderFaIcon from '../components/RenderFaIcon';
import Autocomplete from '../components/Autocomplete';
import StepEditor from '../components/StepEditor';
import RenderStepText from '../components/RenderStepText';
import AppLayout from '../components/AppLayout';

/* ═══════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════ */
interface Ingredient {
  id: string;
  sortOrder: number;
  ingredientId: string | null;
  ingredientName: string;
  subRecipeId?: string | null;
  subRecipeTitle?: string | null;
  quantity: number | null;
  quantityText?: string | null;
  unitId: string | null;
  unitSymbol?: string | null;
  isOptional: boolean;
  notes: string | null;
}

interface StepIngredientRef {
  ingredientSortOrder: number;
  portion: number;
  notes?: string;
}

interface Step {
  id: string;
  stepNumber: number;
  title: string | null;
  translatedTitle?: string | null;
  description: string;
  translatedDescription?: string | null;
  durationMin: number | null;
  toolIds: string[];
  notes: string | null;
  stepIngredients: StepIngredientRef[];
}

interface Tool {
  id: string;
  name: string;
  icon: string | null;
  category: string | null;
  translated_name?: string | null;
}

interface Recipe {
  id: string;
  title: string;
  translated_title?: string | null;
  description: string | null;
  translated_description?: string | null;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  servings: number;
  prep_time_min: number;
  cook_time_min: number;
  rest_time_min: number;
  tags: string[];
  cover_image_url: string;
  source_url: string | null;
  is_component: boolean;
  ingredients: Ingredient[];
  steps: Step[];
  tools: Tool[];
}

type PageMode = 'view' | 'edit' | 'cook';

/* ═══════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════ */
const difficultyLabel: Record<string, string> = {
  easy: 'Easy', medium: 'Intermediate', hard: 'Advanced', expert: 'Expert',
};

const formatTime = (min: number | null | undefined): string => {
  if (!min) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

/* ── Sub-recipe ingredient fetcher ─────────────────────────────────── */
const SubIngredientList: React.FC<{
  subRecipeId: string; servings: number; baseServings: number;
}> = ({ subRecipeId, servings, baseServings }) => {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/recipes/${subRecipeId}`);
        const json = await res.json();
        setIngredients(json.data?.ingredients || []);
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, [subRecipeId]);

  if (loading) return <div className="pl-6 py-2 text-xs text-zinc-400 animate-pulse">Loading…</div>;
  if (!ingredients.length) return null;

  return (
    <div className="ml-4 mt-1 mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] font-bold text-zinc-400 uppercase tracking-wider hover:text-primary transition-colors mb-1"
      >
        <span className="material-symbols-outlined text-sm">{open ? 'expand_less' : 'expand_more'}</span>
        {ingredients.length} sub-ingredients
      </button>
      {open && (
        <div className="space-y-1 pl-2 border-l-2 border-primary/10">
          {ingredients.map((ing, i) => {
            const scaled = ing.quantity ? ((ing.quantity * servings) / baseServings) : null;
            return (
              <div key={i} className="flex justify-between text-sm text-zinc-500 py-1">
                <span>{ing.ingredientName || ing.subRecipeTitle}</span>
                <span className="text-zinc-400 font-medium">
                  {scaled !== null ? scaled % 1 === 0 ? scaled : scaled.toFixed(1) : ''} {ing.unitSymbol || ing.quantityText || ''}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════════════════════════════ */
const RecipeDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const mode: PageMode = (searchParams.get('mode') as PageMode) || 'view';
  const setMode = (m: PageMode) => setSearchParams({ mode: m });

  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [servings, setServings] = useState(4);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [addedToCart, setAddedToCart] = useState(false);

  // Edit-mode draft state
  const [draft, setDraft] = useState<Partial<Recipe>>({});
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [allUnits, setAllUnits] = useState<{ id: string; name: string; symbol: string; translated_name?: string | null }[]>([]);
  const [allIngredients, setAllIngredients] = useState<{ id: string; name: string; translated_name?: string | null }[]>([]);
  const [allTechniques, setAllTechniques] = useState<{ id: string; name: string; translated_name?: string | null }[]>([]);
  const { t, i18n } = useTranslation();
  const contentLang = useStore((s) => s.contentLang);
  const setContentLang = useStore((s) => s.setContentLang);
  const addToShoppingCart = useStore((s) => s.addToShoppingCart);

  const handleLanguageChange = (code: string) => {
    i18n.changeLanguage(code);
    localStorage.setItem('smartchef.uiLang', code);
    setContentLang(code);
  };

  /* ── Fetch techniques (needed in every mode to resolve {{tech:id}} refs in step text) ── */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/techniques${contentLang ? `?lang=${contentLang}` : ''}`);
        const json = await res.json();
        setAllTechniques(json.data || []);
      } catch (err) { console.error('Techniques fetch failed:', err); }
    })();
  }, [contentLang]);

  /* ── Fetch library data (for edit mode) ────────────────────────── */
  useEffect(() => {
    if (mode === 'edit') {
      (async () => {
        try {
          const [tRes, uRes, iRes] = await Promise.all([
            fetch(`/api/tools${contentLang ? `?lang=${contentLang}` : ''}`),
            fetch(`/api/units${contentLang ? `?lang=${contentLang}` : ''}`),
            fetch(`/api/ingredients${contentLang ? `?lang=${contentLang}` : ''}`),
          ]);
          const [tJson, uJson, iJson] = await Promise.all([tRes.json(), uRes.json(), iRes.json()]);
          setAllTools(tJson.data || []);
          setAllUnits(uJson.data || []);
          setAllIngredients(iJson.data || []);
        } catch (err) { console.error('Library fetch failed:', err); }
      })();
    }
  }, [mode, contentLang]);


  /* ── Fetch recipe ───────────────────────────────────────────────── */
  const fetchRecipe = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/recipes/${id}${contentLang ? `?lang=${contentLang}` : ''}`);
      const json = await res.json();
      if (json.data) {
        setRecipe(json.data);
        setServings(json.data.servings);
        setDraft(json.data);
      }
    } catch (err) {
      console.error('Error fetching recipe:', err);
    } finally {
      setLoading(false);
    }
  }, [id, contentLang]);

  useEffect(() => { fetchRecipe(); }, [fetchRecipe]);

  /* ── Scale quantity ─────────────────────────────────────────────── */
  const scale = (qty: number | null): string => {
    if (qty === null) return '';
    if (!recipe) return String(qty);
    const v = (qty * servings) / recipe.servings;
    return v % 1 === 0 ? String(v) : v.toFixed(1);
  };

  /* ── Context for resolving {{ing:N}}/{{tool:id}}/{{tech:id}} inline refs in step text ── */
  const stepTextIngredients = (recipe?.ingredients || []).map(ing => ({
    sortOrder: ing.sortOrder,
    name: ing.ingredientName || ing.subRecipeTitle || 'ingredient',
    quantity: ing.quantity !== null ? `${scale(ing.quantity)}${ing.unitSymbol ? ' ' + ing.unitSymbol : ''}` : '',
  }));
  const stepTextTools = (recipe?.tools || []).map(t => ({ id: t.id, name: t.translated_name || t.name }));
  const stepTextTechniques = allTechniques.map(t => ({ id: t.id, name: t.translated_name || t.name }));

  /* ── Resolve a step's linked ingredients + their portion of the total ── */
  const stepIngredientList = (step: Step) => {
    if (!recipe || !step.stepIngredients?.length) return [];
    return step.stepIngredients.map(ref => {
      const ing = recipe.ingredients.find(i => i.sortOrder === ref.ingredientSortOrder);
      if (!ing) return null;
      const portionQty = ing.quantity !== null ? ing.quantity * ref.portion : null;
      return {
        name: ing.ingredientName || ing.subRecipeTitle || 'Ingredient',
        quantity: scale(portionQty),
        unitSymbol: ing.unitSymbol || '',
        portionPct: Math.round(ref.portion * 100),
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  };

  /* ── Toggle step complete (cooking mode) ────────────────────────── */
  const toggleStep = (n: number) => {
    setCompletedSteps(prev => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  };

  /* ── Save recipe (edit mode) ────────────────────────────────────── */
  const handleSave = async () => {
    if (!id || !draft.title) return;
    setSaving(true);
    try {
      const body = {
        title: draft.title,
        description: draft.description || '',
        difficulty: draft.difficulty || 'medium',
        servings: draft.servings || 4,
        prepTimeMin: draft.prep_time_min || undefined,
        cookTimeMin: draft.cook_time_min || undefined,
        restTimeMin: draft.rest_time_min || undefined,
        tags: draft.tags || [],
        coverImageUrl: draft.cover_image_url || null,
        sourceUrl: draft.source_url || null,
        isComponent: draft.is_component || false,
        ingredients: (draft.ingredients || []).map((ing, i) => ({
          sortOrder: i,
          ingredientId: ing.ingredientId || undefined,
          subRecipeId: ing.subRecipeId || undefined,
          quantity: ing.quantity || undefined,
          quantityText: ing.quantityText || undefined,
          unitId: ing.unitId || undefined,
          isOptional: ing.isOptional || false,
          notes: ing.notes || undefined,
        })),
        steps: (draft.steps || []).map((s, i) => ({
          stepNumber: i + 1,
          title: s.title || undefined,
          description: s.description,
          durationMin: s.durationMin || undefined,
          toolIds: s.toolIds || [],
          notes: s.notes || undefined,
          stepIngredients: s.stepIngredients || [],
        })),
        toolIds: (draft.tools || []).map(t => t.id),
      };

      await fetch(`/api/recipes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await fetchRecipe();
      setMode('view');
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  /* ── Delete recipe ──────────────────────────────────────────────── */
  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm(`Delete "${recipe?.translated_title || recipe?.title}"? This cannot be undone.`)) return;
    setSaving(true);
    try {
      await fetch(`/api/recipes/${id}`, { method: 'DELETE' });
      navigate('/');
    } catch (err) {
      console.error('Delete failed:', err);
      setSaving(false);
    }
  };

  /* ── Loading / Error ────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="min-h-screen bg-[#fafaf5] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-[3px] border-primary/20 border-t-primary" />
          <p className="text-sm text-zinc-400 font-medium">Loading recipe…</p>
        </div>
      </div>
    );
  }
  if (!recipe) {
    return (
      <div className="min-h-screen bg-[#fafaf5] flex items-center justify-center">
        <div className="text-center">
          <span className="material-symbols-outlined text-6xl text-zinc-300 mb-4 block">error</span>
          <p className="text-zinc-500 font-medium">Recipe not found.</p>
          <Link to="/" className="text-primary font-bold text-sm mt-4 inline-block hover:underline">← Back to Gallery</Link>
        </div>
      </div>
    );
  }

  const totalTime = (recipe.prep_time_min || 0) + (recipe.cook_time_min || 0) + (recipe.rest_time_min || 0);

  /* ═════════════════════════════════════════════════════════════════
     COOKING MODE
     ═════════════════════════════════════════════════════════════════ */
  if (mode === 'cook') {
    const sortedSteps = [...(recipe.steps || [])].sort((a, b) => a.stepNumber - b.stepNumber);
    const progress = recipe.steps.length > 0 ? (completedSteps.size / recipe.steps.length) * 100 : 0;

    return (
      <div className="min-h-screen bg-zinc-900 text-white font-body">
        {/* Header */}
        <header className="sticky top-0 z-50 bg-zinc-900/95 backdrop-blur-md border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
          <button onClick={() => setMode('view')} className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
            <span className="material-symbols-outlined">arrow_back</span>
            <span className="text-sm font-bold">Exit Kitchen</span>
          </button>
          <h2 className="text-lg font-headline font-bold text-white truncate max-w-md">{recipe.translated_title || recipe.title}</h2>
          <div className="text-sm text-zinc-400 font-medium">{completedSteps.size}/{recipe.steps.length} steps</div>
        </header>

        {/* Progress bar */}
        <div className="h-1 bg-zinc-800">
          <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>

        {/* Steps */}
        <main className="max-w-3xl mx-auto px-6 py-10 space-y-8">
          {sortedSteps.map((step) => {
            const done = completedSteps.has(step.stepNumber);
            return (
              <div
                key={step.stepNumber}
                className={`p-8 rounded-3xl border transition-all duration-300 ${
                  done
                    ? 'bg-primary/10 border-primary/30 opacity-60'
                    : 'bg-zinc-800/50 border-zinc-700/50 hover:border-zinc-600'
                }`}
              >
                <div className="flex items-start gap-6">
                  <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-headline font-extrabold text-xl shrink-0 ${
                    done ? 'bg-primary text-white' : 'bg-zinc-700 text-zinc-300'
                  }`}>
                    {done ? <span className="material-symbols-outlined">check</span> : step.stepNumber.toString().padStart(2, '0')}
                  </div>
                  <div className="flex-1">
                    <h3 className={`font-headline font-bold text-xl mb-3 ${done ? 'text-primary line-through' : 'text-white'}`}>
                      {step.translatedTitle || step.title || `Step ${step.stepNumber}`}
                    </h3>
                    <p className="text-zinc-300 leading-relaxed text-[15px] mb-4">
                      <RenderStepText text={step.translatedDescription || step.description} ingredients={stepTextIngredients} tools={stepTextTools} techniques={stepTextTechniques} />
                    </p>

                    {stepIngredientList(step).length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-4">
                        {stepIngredientList(step).map((si, i) => (
                          <span key={i} className="px-2.5 py-1 bg-primary/10 text-primary text-xs font-bold rounded-lg">
                            {si.name}{si.quantity ? `: ${si.quantity}${si.unitSymbol ? ' ' + si.unitSymbol : ''}` : ''}
                            {si.portionPct < 100 ? ` (${si.portionPct}%)` : ''}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Step Tools */}
                    {step.toolIds && step.toolIds.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-4">
                        {step.toolIds.map(tid => {
                          const tool = recipe.tools?.find(t => t.id === tid);
                          if (!tool) return null;
                          return (
                            <div key={tid} className="flex items-center gap-1.5 px-2 py-1 bg-zinc-700/50 rounded-lg border border-zinc-600/30">
                              <RenderFaIcon name={tool.icon || 'FaKitchenSet'} className="text-primary text-sm" />
                              <span className="text-[10px] uppercase font-bold text-zinc-400">{tool.translated_name || tool.name}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {step.durationMin && (
                      <div className="flex items-center gap-2 text-sm text-zinc-400 mb-4">
                        <span className="material-symbols-outlined text-sm">timer</span>
                        {step.durationMin} minutes
                      </div>
                    )}

                    {/* Step Note */}
                    {step.notes && (
                      <div className="bg-primary/10 border border-primary/20 rounded-2xl p-4 mb-6">
                        <div className="flex items-center gap-2 text-primary mb-1">
                          <span className="material-symbols-outlined text-sm text-[18px]">lightbulb</span>
                          <span className="text-[10px] uppercase font-bold tracking-wider">Chef's Note</span>
                        </div>
                        <p className="text-sm text-zinc-300 italic">{step.notes}</p>
                      </div>
                    )}

                    <button
                      onClick={() => toggleStep(step.stepNumber)}
                      className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-sm transition-all ${
                        done
                          ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                          : 'bg-primary text-white hover:bg-primary/80'
                      }`}
                    >
                      <span className="material-symbols-outlined text-sm">{done ? 'undo' : 'check_circle'}</span>
                      {done ? 'UNDO' : 'MARK AS COMPLETE'}
                    </button>

                  </div>
                </div>
              </div>
            );
          })}

          {progress === 100 && (
            <div className="text-center py-12 animate-fade-in-up">
              <span className="text-6xl mb-4 block">🎉</span>
              <h2 className="font-headline font-extrabold text-3xl text-primary mb-2">Buon Appetito!</h2>
              <p className="text-zinc-400">All steps completed. Your dish is ready to serve.</p>
              <button onClick={() => setMode('view')} className="mt-6 px-8 py-3 bg-primary text-white rounded-full font-bold hover:bg-primary/80 transition-colors">
                Back to Recipe
              </button>
            </div>
          )}
        </main>
      </div>
    );
  }

  /* ═════════════════════════════════════════════════════════════════
     EDIT MODE
     ═════════════════════════════════════════════════════════════════ */
  if (mode === 'edit') {
    const updateDraft = (field: string, value: unknown) =>
      setDraft(prev => ({ ...prev, [field]: value }));
    const updateStep = (idx: number, field: string, value: unknown) =>
      setDraft(prev => ({
        ...prev,
        steps: (prev.steps || []).map((s, i) => i === idx ? { ...s, [field]: value } : s),
      }));
    const addStep = () =>
      setDraft(prev => ({
        ...prev,
        steps: [...(prev.steps || []), { id: '', stepNumber: (prev.steps?.length || 0) + 1, title: '', description: '', durationMin: null, toolIds: [], notes: '', stepIngredients: [] }],
      }));
    const removeStep = (idx: number) =>
      setDraft(prev => ({
        ...prev,
        steps: (prev.steps || []).filter((_, i) => i !== idx).map((s, i) => ({ ...s, stepNumber: i + 1 })),
      }));

    const toggleStepIngredient = (stepIdx: number, ingredientSortOrder: number) =>
      setDraft(prev => ({
        ...prev,
        steps: (prev.steps || []).map((s, i) => {
          if (i !== stepIdx) return s;
          const existing = s.stepIngredients || [];
          const has = existing.some(si => si.ingredientSortOrder === ingredientSortOrder);
          return {
            ...s,
            stepIngredients: has
              ? existing.filter(si => si.ingredientSortOrder !== ingredientSortOrder)
              : [...existing, { ingredientSortOrder, portion: 1 }],
          };
        }),
      }));

    const updateStepIngredientPortion = (stepIdx: number, ingredientSortOrder: number, portion: number) =>
      setDraft(prev => ({
        ...prev,
        steps: (prev.steps || []).map((s, i) => i === stepIdx ? {
          ...s,
          stepIngredients: (s.stepIngredients || []).map(si =>
            si.ingredientSortOrder === ingredientSortOrder ? { ...si, portion } : si
          ),
        } : s),
      }));

    // Adds (or updates the portion of) a step ingredient — unlike
    // toggleStepIngredient this never removes, used when inserting an
    // inline {{ing:N}} reference from the step text toolbar.
    const setStepIngredient = (stepIdx: number, ingredientSortOrder: number, portion: number) =>
      setDraft(prev => ({
        ...prev,
        steps: (prev.steps || []).map((s, i) => {
          if (i !== stepIdx) return s;
          const existing = s.stepIngredients || [];
          const has = existing.some(si => si.ingredientSortOrder === ingredientSortOrder);
          return {
            ...s,
            stepIngredients: has
              ? existing.map(si => si.ingredientSortOrder === ingredientSortOrder ? { ...si, portion } : si)
              : [...existing, { ingredientSortOrder, portion }],
          };
        }),
      }));

    const addToolToStep = (stepIdx: number, toolId: string) =>
      setDraft(prev => ({
        ...prev,
        steps: (prev.steps || []).map((s, i) => i === stepIdx && !(s.toolIds || []).includes(toolId)
          ? { ...s, toolIds: [...(s.toolIds || []), toolId] }
          : s),
      }));

    const updateIngredient = (idx: number, field: string, value: unknown) =>
      setDraft(prev => ({
        ...prev,
        ingredients: (prev.ingredients || []).map((ing, i) => i === idx ? { ...ing, [field]: value } : ing),
      }));
    const addIngredient = () =>
      setDraft(prev => ({
        ...prev,
        ingredients: [...(prev.ingredients || []), { id: '', sortOrder: (prev.ingredients?.length || 0), ingredientId: null, ingredientName: '', quantity: 1, unitId: null, isOptional: false, notes: '' }],
      }));
    const removeIngredient = (idx: number) =>
      setDraft(prev => ({
        ...prev,
        ingredients: (prev.ingredients || []).filter((_, i) => i !== idx).map((ing, i) => ({ ...ing, sortOrder: i })),
        steps: (prev.steps || []).map(s => ({
          ...s,
          stepIngredients: (s.stepIngredients || [])
            .filter(si => si.ingredientSortOrder !== idx)
            .map(si => si.ingredientSortOrder > idx ? { ...si, ingredientSortOrder: si.ingredientSortOrder - 1 } : si),
        })),
      }));

    const toggleTool = (tool: Tool) =>
      setDraft(prev => {
        const tools = prev.tools || [];
        const exists = tools.find(t => t.id === tool.id);
        if (exists) return { ...prev, tools: tools.filter(t => t.id !== tool.id) };
        return { ...prev, tools: [...tools, tool] };
      });

    return (
      <div className="min-h-screen bg-[#fafaf5] font-body">
        {/* Header */}
        <header className="bg-[#fafaf5]/90 backdrop-blur-md sticky top-0 z-50 border-b border-zinc-200/60 px-8 py-4 flex items-center justify-between">
          <button onClick={() => { setDraft(recipe); setMode('view'); }} className="flex items-center gap-2 text-zinc-500 hover:text-zinc-800 transition-colors">
            <span className="material-symbols-outlined">close</span>
            <span className="text-sm font-bold">Cancel</span>
          </button>
          <h2 className="text-lg font-headline font-bold text-zinc-800">Edit Recipe</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={handleDelete}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-red-500 hover:bg-red-50 rounded-full font-bold text-sm transition-all disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">delete</span>
              Delete
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2 bg-primary text-white rounded-full font-bold text-sm hover:bg-primary/90 transition-all disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">{saving ? 'sync' : 'save'}</span>
              {saving ? 'Saving…' : 'Save Recipe'}
            </button>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-6 py-10 space-y-8">
          {/* Title & description */}
          <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
            <label className="block mb-6">
              <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">Recipe Title</span>
              <input
                type="text" value={draft.title || ''}
                onChange={e => updateDraft('title', e.target.value)}
                className="w-full text-3xl font-headline font-bold border-none bg-transparent focus:ring-0 p-0 placeholder:text-zinc-300"
                placeholder="Enter recipe title…"
              />
            </label>
            <label className="block mb-6">
              <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">Description</span>
              <textarea
                value={draft.description || ''}
                onChange={e => updateDraft('description', e.target.value)}
                className="w-full border-none bg-zinc-50 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[80px]"
                placeholder="Short description…"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">Cover Image URL</span>
              <input
                type="url" value={draft.cover_image_url || ''}
                onChange={e => updateDraft('cover_image_url', e.target.value)}
                className="w-full border-none bg-zinc-50 rounded-xl p-4 text-sm focus:ring-2 focus:ring-primary/20"
                placeholder="https://…"
              />
            </label>
          </div>

          {/* Metadata grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Servings', field: 'servings', type: 'number' },
              { label: 'Prep (min)', field: 'prep_time_min', type: 'number' },
              { label: 'Cook (min)', field: 'cook_time_min', type: 'number' },
              { label: 'Rest (min)', field: 'rest_time_min', type: 'number' },
            ].map(f => (
              <label key={f.field} className="bg-white rounded-2xl p-5 shadow-[0_1px_6px_rgba(0,0,0,0.03)]">
                <span className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold block mb-2">{f.label}</span>
                <input
                  type="number" value={String((draft as any)[f.field] || '')}
                  onChange={e => updateDraft(f.field, e.target.value ? parseInt(e.target.value) : null)}
                  className="w-full border-none bg-transparent text-2xl font-bold text-zinc-800 p-0 focus:ring-0"
                />
              </label>
            ))}
          </div>

          {/* Difficulty + Tags */}
          <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
            <div className="flex flex-wrap gap-6">
              <label>
                <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">Difficulty</span>
                <select
                  value={draft.difficulty || 'medium'}
                  onChange={e => updateDraft('difficulty', e.target.value)}
                  className="border-none bg-zinc-50 rounded-xl px-4 py-3 font-medium text-sm focus:ring-2 focus:ring-primary/20"
                >
                  {['easy','medium','hard','expert'].map(d => (
                    <option key={d} value={d}>{difficultyLabel[d]}</option>
                  ))}
                </select>
              </label>
              <label className="flex-1 min-w-[200px]">
                <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">Tags (comma separated)</span>
                <input
                  type="text"
                  value={(draft.tags || []).join(', ')}
                  onChange={e => updateDraft('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
                  className="w-full border-none bg-zinc-50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20"
                  placeholder="italian, pasta, main course"
                />
              </label>
            </div>
          </div>

          {/* Kitchen Tools Selector */}
          <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
            <h3 className="font-headline font-bold text-xl mb-6">Kitchen Tools</h3>
            <div className="flex flex-wrap gap-3">
              {allTools.map(tool => {
                const isSelected = (draft.tools || []).some(t => t.id === tool.id);
                return (
                  <button
                    key={tool.id}
                    onClick={() => toggleTool(tool)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl border-2 transition-all ${
                      isSelected
                        ? 'bg-primary/10 border-primary text-primary'
                        : 'bg-zinc-50 border-zinc-100 text-zinc-500 hover:border-zinc-300'
                    }`}
                  >
                    <RenderFaIcon name={tool.icon || 'FaKitchenSet'} className="text-lg" />
                    <span className="text-sm font-bold">{tool.translated_name || tool.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Ingredients Editor */}
          <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-headline font-bold text-xl">Ingredients</h3>
              <button onClick={addIngredient} className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-full text-sm font-bold hover:bg-primary/90 transition-colors">
                <span className="material-symbols-outlined text-sm">add</span> Add Ingredient
              </button>
            </div>
            <div className="space-y-4">
              {(draft.ingredients || []).map((ing, idx) => (
                <div key={idx} className="bg-zinc-50 rounded-2xl p-6 relative group border border-zinc-100">
                  <button
                    onClick={() => removeIngredient(idx)}
                    className="absolute top-3 right-3 w-8 h-8 rounded-full bg-red-50 text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-100"
                  >
                    <span className="material-symbols-outlined text-sm">delete</span>
                  </button>
                  <div className="grid grid-cols-12 gap-4">
                    <div className="col-span-6">
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">Ingredient</label>
                      <Autocomplete
                        value={ing.ingredientId || ''}
                        options={allIngredients.map(i => ({ id: i.id, label: i.translated_name || i.name }))}
                        onSelect={(id, label) => {
                          updateIngredient(idx, 'ingredientId', id);
                          updateIngredient(idx, 'ingredientName', label);
                        }}
                        onClear={() => {
                          updateIngredient(idx, 'ingredientId', null);
                          updateIngredient(idx, 'ingredientName', '');
                        }}
                        placeholder="Type to search…"
                        className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <div className="col-span-3">
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">Qty</label>
                      <input
                        type="number" step="any" value={ing.quantity || ''}
                        onChange={e => updateIngredient(idx, 'quantity', parseFloat(e.target.value))}
                        className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      />
                    </div>
                    <div className="col-span-3">
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">Unit</label>
                      <select
                        value={ing.unitId || ''}
                        onChange={e => {
                          const sym = allUnits.find(u => u.id === e.target.value)?.symbol || '';
                          updateIngredient(idx, 'unitId', e.target.value);
                          updateIngredient(idx, 'unitSymbol', sym);
                        }}
                        className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      >
                        <option value="">Unit...</option>
                        {allUnits.map(u => <option key={u.id} value={u.id}>{u.symbol} ({u.translated_name || u.name})</option>)}
                      </select>
                    </div>
                    <div className="col-span-12">
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">Chef's Note (Optional)</label>
                      <input
                        type="text" value={ing.notes || ''}
                        onChange={e => updateIngredient(idx, 'notes', e.target.value)}
                        className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                        placeholder="e.g. freshly grated, cold, etc."
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Steps editor */}
          <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-headline font-bold text-xl">Steps</h3>
              <button onClick={addStep} className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-full text-sm font-bold hover:bg-primary/90 transition-colors">
                <span className="material-symbols-outlined text-sm">add</span> Add Step
              </button>
            </div>
            <div className="space-y-4">
              {(draft.steps || []).map((step, idx) => (
                <div key={idx} className="bg-zinc-50 rounded-2xl p-6 relative group">
                  <button
                    onClick={() => removeStep(idx)}
                    className="absolute top-3 right-3 w-8 h-8 rounded-full bg-red-50 text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-100"
                  >
                    <span className="material-symbols-outlined text-sm">delete</span>
                  </button>
                  <div className="flex items-center gap-3 mb-3">
                    <span className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-sm">{idx + 1}</span>
                    <input
                      type="text" value={step.title || ''}
                      onChange={e => updateStep(idx, 'title', e.target.value)}
                      className="flex-1 border-none bg-transparent font-headline font-bold text-lg p-0 focus:ring-0"
                      placeholder="Step title (optional)"
                    />
                  </div>
                  <StepEditor
                    description={step.description}
                    onChangeDescription={text => updateStep(idx, 'description', text)}
                    ingredients={draft.ingredients || []}
                    tools={draft.tools || []}
                    techniques={allTechniques.map(t => ({ id: t.id, name: t.translated_name || t.name }))}
                    onInsertIngredient={(sortOrder, portion) => setStepIngredient(idx, sortOrder, portion)}
                    onInsertTool={(toolId) => addToolToStep(idx, toolId)}
                  />
                  <textarea
                    value={step.notes || ''}
                    onChange={e => updateStep(idx, 'notes', e.target.value)}
                    className="w-full mt-3 border border-dashed border-primary/20 bg-primary/5 rounded-xl p-3 text-xs italic resize-none focus:ring-2 focus:ring-primary/20 min-h-[60px]"
                    placeholder="Chef's Note: (e.g. Ensure the final layer is completely covered)"
                  />
                  
                  <div className="grid grid-cols-2 gap-4 mt-4">

                    <div>
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">Duration (min)</label>
                      <input
                        type="number" value={step.durationMin || ''}
                        onChange={e => updateStep(idx, 'durationMin', e.target.value ? parseInt(e.target.value) : null)}
                        className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                        placeholder="min"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">Tools for this step</label>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {(draft.tools || []).map(tool => {
                          const isUsed = (step.toolIds || []).includes(tool.id);
                          return (
                            <button
                              key={tool.id}
                              onClick={() => {
                                const current = step.toolIds || [];
                                const next = current.includes(tool.id) ? current.filter(id => id !== tool.id) : [...current, tool.id];
                                updateStep(idx, 'toolIds', next);
                              }}
                              className={`p-1.5 rounded-lg border transition-all ${
                                isUsed ? 'bg-primary text-white border-primary' : 'bg-white text-zinc-400 border-zinc-100 hover:border-zinc-300'
                              }`}
                              title={tool.translated_name || tool.name}
                            >
                              <RenderFaIcon name={tool.icon || 'FaKitchenSet'} className="text-lg" />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {(draft.ingredients || []).length > 0 && (
                    <div className="mt-4">
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">Ingredients used in this step</label>
                      <div className="space-y-1.5 mt-1">
                        {(draft.ingredients || []).map(ing => {
                          const ref = (step.stepIngredients || []).find(si => si.ingredientSortOrder === ing.sortOrder);
                          const isUsed = !!ref;
                          return (
                            <div key={ing.sortOrder} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all ${isUsed ? 'bg-primary/5 border-primary/20' : 'bg-white border-zinc-100'}`}>
                              <button
                                type="button"
                                onClick={() => toggleStepIngredient(idx, ing.sortOrder)}
                                className={`text-xs font-bold flex-1 text-left ${isUsed ? 'text-primary' : 'text-zinc-400 hover:text-zinc-600'}`}
                              >
                                {ing.ingredientName || ing.subRecipeTitle || 'Unnamed ingredient'}
                                {ing.quantity ? ` (${ing.quantity}${ing.unitSymbol ? ' ' + ing.unitSymbol : ''} total)` : ''}
                              </button>
                              {isUsed && (
                                <>
                                  <input
                                    type="range" min="0.05" max="1" step="0.05"
                                    value={ref!.portion}
                                    onChange={e => updateStepIngredientPortion(idx, ing.sortOrder, parseFloat(e.target.value))}
                                    className="w-24 accent-primary"
                                  />
                                  <span className="text-[10px] font-bold text-zinc-500 w-10 text-right">{Math.round(ref!.portion * 100)}%</span>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    );
  }


  /* ═════════════════════════════════════════════════════════════════
     VIEW MODE (matches the screenshot design)
     ═════════════════════════════════════════════════════════════════ */
  const sortedIngredients = [...(recipe.ingredients || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const sortedSteps = [...recipe.steps].sort((a, b) => a.stepNumber - b.stepNumber);

  const editButton = (
    <button
      onClick={() => setMode('edit')}
      className="flex items-center gap-1.5 text-zinc-500 hover:text-primary transition-colors"
      aria-label="Edit recipe"
    >
      <span className="material-symbols-outlined text-[20px]">edit</span>
    </button>
  );

  return (
    <AppLayout headerActions={editButton}>
      {/* ── Hero Image ─────────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-6 pt-8">
        <div className="relative h-[360px] md:h-[440px] rounded-3xl overflow-hidden">
          <img className="w-full h-full object-cover" src={recipe.cover_image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?q=80&w=2000'} alt={recipe.translated_title || recipe.title} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          <div className="absolute bottom-8 left-8 right-8">
            {recipe.tags?.[0] && (
              <span className="inline-block px-3 py-1 bg-primary text-white text-[10px] font-bold uppercase tracking-[0.15em] rounded-full mb-3">
                {recipe.tags[0]}
              </span>
            )}
            <h1 className="text-4xl md:text-6xl font-headline font-extrabold text-white leading-none">{recipe.translated_title || recipe.title}</h1>
          </div>
        </div>
      </div>

      {/* ── Stats Bar ──────────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-6 mt-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Prep Time', val: formatTime(recipe.prep_time_min), icon: 'schedule' },
            { label: 'Cook Time', val: formatTime(recipe.cook_time_min), icon: 'oven_gen' },
            { label: 'Total Time', val: formatTime(totalTime), icon: 'local_fire_department' },
            { label: 'Complexity', val: difficultyLabel[recipe.difficulty] || recipe.difficulty, icon: 'restaurant', highlight: true },
          ].map((stat, i) => (
            <div key={i} className={`py-5 px-4 rounded-2xl flex flex-col items-center text-center ${stat.highlight ? 'bg-primary/8 border border-primary/15' : 'bg-white border border-zinc-100'}`}>
              <span className={`material-symbols-outlined mb-1.5 ${stat.highlight ? 'text-primary' : 'text-primary/60'}`} style={{ fontVariationSettings: "'FILL' 1" }}>{stat.icon}</span>
              <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 font-bold">{stat.label}</p>
              <p className={`text-lg font-bold font-headline ${stat.highlight ? 'text-primary' : 'text-zinc-800'}`}>{stat.val}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Two-column layout ──────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-6 mt-10 pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">

          {/* Left column: Servings + Ingredients */}
          <div className="lg:col-span-4 space-y-8">
            {/* Servings card */}
            <div className="bg-white rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-headline font-bold text-lg">Servings</h3>
                <span className="text-3xl font-extrabold text-primary font-headline">{servings}</span>
              </div>
              <input
                type="range" min="1" max="12"
                value={servings}
                onChange={(e) => setServings(parseInt(e.target.value))}
                className="w-full h-2 bg-zinc-100 rounded-full appearance-none cursor-pointer accent-primary"
              />
              <div className="flex justify-between mt-2 text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                <span>1 portion</span><span>12 portions</span>
              </div>
              <button
                onClick={() => {
                  addToShoppingCart({ recipeId: id!, title: recipe.translated_title || recipe.title, servings });
                  setAddedToCart(true);
                  setTimeout(() => setAddedToCart(false), 2000);
                }}
                className={`w-full mt-5 py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all ${
                  addedToCart ? 'bg-primary/10 text-primary' : 'bg-zinc-900 text-white hover:bg-zinc-800'
                }`}
              >
                <span className="material-symbols-outlined text-lg">{addedToCart ? 'check' : 'shopping_cart'}</span>
                {addedToCart ? 'Added to Shopping List' : 'Add to Shopping List'}
              </button>
            </div>

            {/* Ingredients card */}
            <div className="bg-white rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100">
              <h3 className="font-headline font-bold text-lg mb-5">Ingredients</h3>
              <div className="space-y-1">
                {sortedIngredients.map((ing, idx) => (
                  <div key={idx}>
                    <div className={`flex items-center justify-between py-3 px-3 rounded-xl transition-colors hover:bg-zinc-50 ${ing.subRecipeId ? 'bg-zinc-50/60' : ''}`}>
                      <div className="flex items-center gap-2">
                        {ing.subRecipeId && (
                          <span className="material-symbols-outlined text-primary text-[18px]">package_2</span>
                        )}
                        <span className={`text-sm ${ing.subRecipeId ? 'font-bold text-zinc-800' : 'text-zinc-700'}`}>
                          {ing.ingredientName || ing.subRecipeTitle}
                        </span>
                      </div>
                      <span className="text-sm text-zinc-500 font-semibold tabular-nums">
                        {scale(ing.quantity)} {ing.unitSymbol || ing.quantityText || ''}
                      </span>
                    </div>
                    {ing.notes && (
                      <p className="px-3 pb-2 text-[11px] text-zinc-400 font-medium italic">— {ing.notes}</p>
                    )}
                    {ing.subRecipeId && (
                      <SubIngredientList
                        subRecipeId={ing.subRecipeId}
                        servings={servings}
                        baseServings={recipe.servings}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Kitchen Tools card */}
            {recipe.tools && recipe.tools.length > 0 && (
              <div className="bg-white rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100">
                <h3 className="font-headline font-bold text-lg mb-5">Kitchen Tools</h3>
                <div className="flex flex-wrap gap-2">
                  {recipe.tools.map(tool => (
                    <div key={tool.id} className="flex items-center gap-2 px-3 py-2 bg-zinc-50 rounded-xl border border-zinc-100">
                      <RenderFaIcon name={tool.icon || 'FaKitchenSet'} className="text-primary text-lg" />
                      <span className="text-xs font-bold text-zinc-600">{tool.translated_name || tool.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>


          {/* Right column: Method + Kitchen Mode button */}
          <div className="lg:col-span-8">
            <div className="flex items-center justify-between mb-8">
              <h2 className="font-headline font-extrabold text-3xl text-zinc-900">The Method</h2>
              <button
                onClick={() => { setCompletedSteps(new Set()); setMode('cook'); }}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-full font-bold text-sm shadow-sm hover:bg-primary/90 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>skillet</span>
                Kitchen Mode
              </button>
            </div>

            <div className="space-y-8">
              {sortedSteps.map((step, idx) => (
                <div key={step.id} className="flex gap-6 group">
                  {/* Step number + connector line */}
                  <div className="flex flex-col items-center">
                    <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center font-headline font-extrabold text-lg shrink-0">
                      {step.stepNumber.toString().padStart(2, '0')}
                    </div>
                    {idx < sortedSteps.length - 1 && (
                      <div className="w-0.5 flex-1 bg-zinc-200 mt-3" />
                    )}
                  </div>

                  {/* Step content */}
                  <div className="flex-1 pb-6">
                    <h4 className="font-headline font-bold text-xl text-zinc-800 mb-3">
                      {step.translatedTitle || step.title || `Step ${step.stepNumber}`}
                    </h4>
                    <div className="bg-white p-6 rounded-2xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 group-hover:border-primary/15 transition-colors">
                      <p className="text-[15px] leading-relaxed text-zinc-600 mb-4">
                        <RenderStepText text={step.translatedDescription || step.description} ingredients={stepTextIngredients} tools={stepTextTools} techniques={stepTextTechniques} />
                      </p>

                      {stepIngredientList(step).length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-4">
                          {stepIngredientList(step).map((si, i) => (
                            <span key={i} className="px-2.5 py-1 bg-primary/10 text-primary text-xs font-bold rounded-lg">
                              {si.name}{si.quantity ? `: ${si.quantity}${si.unitSymbol ? ' ' + si.unitSymbol : ''}` : ''}
                              {si.portionPct < 100 ? ` (${si.portionPct}%)` : ''}
                            </span>
                          ))}
                        </div>
                      )}

                      {step.durationMin && (
                        <div className="flex items-center gap-2 text-sm text-zinc-400 mb-4">
                          <span className="material-symbols-outlined text-sm">timer</span>
                          {step.durationMin} minutes
                        </div>
                      )}

                      <label className="flex items-center gap-3 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={completedSteps.has(step.stepNumber)}
                          onChange={() => toggleStep(step.stepNumber)}
                          className="w-5 h-5 rounded border-zinc-300 text-primary focus:ring-primary/30"
                        />
                        <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-zinc-400">Mark as Complete</span>
                      </label>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
};

export default RecipeDetail;