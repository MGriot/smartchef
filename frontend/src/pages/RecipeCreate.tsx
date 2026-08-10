import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import RenderFaIcon from '../components/RenderFaIcon';
import Autocomplete from '../components/Autocomplete';
import { useStore } from '../store/app.store';

/* ── Types ─────────────────────────────────────────────────── */
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
  description: string;
  durationMin: number | null;
  toolIds: string[];
  notes: string | null;
  stepIngredients: StepIngredientRef[];
}

interface Tool {
  id: string;
  name: string;
  icon: string | null;
  translated_name?: string | null;
}

interface Recipe {
  id: string;
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  servings: number;
  prep_time_min: number | null;
  cook_time_min: number | null;
  rest_time_min: number | null;
  tags: string[];
  cover_image_url: string | null;
  source_url: string | null;
  is_component: boolean;
  ingredients: Ingredient[];
  steps: Step[];
  tools: Tool[];
}

const difficultyLabel: Record<string, string> = {
  easy: 'Easy',
  medium: 'Intermediate',
  hard: 'Advanced',
  expert: 'Expert',
};

const RecipeCreate: React.FC = () => {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  
  // Library data
  const contentLang = useStore((s) => s.contentLang);
  const langQuery = contentLang ? `?lang=${contentLang}` : '';
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [allUnits, setAllUnits] = useState<{ id: string; name: string; symbol: string; translated_name?: string | null }[]>([]);
  const [allIngredients, setAllIngredients] = useState<{ id: string; name: string; translated_name?: string | null }[]>([]);

  // Draft state
  const [draft, setDraft] = useState<Partial<Recipe>>({
    title: '',
    description: '',
    difficulty: 'medium',
    servings: 4,
    prep_time_min: null,
    cook_time_min: null,
    rest_time_min: null,
    tags: [],
    cover_image_url: '',
    is_component: false,
    ingredients: [],
    steps: [],
    tools: [],
  });

  /* ── Fetch library data ────────────────────────── */
  useEffect(() => {
    (async () => {
      try {
        const [tRes, uRes, iRes] = await Promise.all([
          fetch(`/api/tools${langQuery}`),
          fetch(`/api/units${langQuery}`),
          fetch(`/api/ingredients${langQuery}`),
        ]);
        const [tJson, uJson, iJson] = await Promise.all([tRes.json(), uRes.json(), iRes.json()]);
        setAllTools(tJson.data || []);
        setAllUnits(uJson.data || []);
        setAllIngredients(iJson.data || []);
      } catch (err) {
        console.error('RecipeCreate: Library fetch failed:', err);
      }
    })();
  }, [contentLang]);

  /* ── Helpers ───────────────────────────────────── */
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

  const removeStep = (idx: number) =>
    setDraft(prev => ({
      ...prev,
      steps: (prev.steps || []).filter((_, i) => i !== idx).map((s, i) => ({ ...s, stepNumber: i + 1 })),
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
      // Drop step references to the removed ingredient and shift down references
      // to ingredients that moved up a slot, so sortOrder links stay accurate.
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

  /* ── Save logic ────────────────────────────────── */
  const handleSave = async () => {
    if (!draft.title) return;
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

      const res = await fetch('/api/recipes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (res.ok && json.data?.id) {
        console.log('RecipeCreate: Save success, navigating to:', json.data.id);
        navigate(`/recipe/${json.data.id}`);
      } else {
        const errMsg = json.error ? JSON.stringify(json.error) : 'Unknown error';
        console.error('RecipeCreate: Save failed', errMsg);
        window.alert(`Failed to create recipe: ${errMsg}`);
        setSaving(false);
      }
    } catch (err) {
      console.error('RecipeCreate: Save request failed:', err);
      window.alert('Failed to connect to the server. Please check your connection.');
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#fafaf5] font-body">
      {/* Header */}
      <header className="bg-[#fafaf5]/90 backdrop-blur-md sticky top-0 z-50 border-b border-zinc-200/60 px-8 py-4 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 text-zinc-500 hover:text-zinc-800 transition-colors">
          <span className="material-symbols-outlined">close</span>
          <span className="text-sm font-bold">Cancel</span>
        </Link>
        <h2 className="text-lg font-headline font-bold text-zinc-800">New Recipe</h2>
        <button
          onClick={handleSave}
          disabled={saving || !draft.title}
          className="flex items-center gap-2 px-5 py-2 bg-primary text-white rounded-full font-bold text-sm hover:bg-primary/90 transition-all disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">{saving ? 'sync' : 'add'}</span>
          {saving ? 'Creating…' : 'Create Recipe'}
        </button>
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
              <div key={idx} className="bg-zinc-50 rounded-2xl p-6 relative group border border-zinc-100">
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
                <textarea
                  value={step.description}
                  onChange={e => updateStep(idx, 'description', e.target.value)}
                  className="w-full border-none bg-white rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[80px]"
                  placeholder="Describe this step…"
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
                              {ing.ingredientName || 'Unnamed ingredient'}
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
};

export default RecipeCreate;
