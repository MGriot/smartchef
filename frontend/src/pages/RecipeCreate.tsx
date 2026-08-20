import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import RenderFaIcon from '../components/RenderFaIcon';
import Autocomplete from '../components/Autocomplete';
import StepEditor, { StepIngredientAmount } from '../components/StepEditor';
import RecipeSourcesEditor, { RecipeSourceEntry } from '../components/RecipeSourcesEditor';
import ImageUrlInput from '../components/ImageUrlInput';
import TranslationsEditor, { TranslationEntry } from '../components/TranslationsEditor';
import TagPicker from '../components/TagPicker';
import RegionPicker from '../components/RegionPicker';
import RegionsMap from '../components/RegionsMap';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useStore } from '../store/app.store';
import { SUPPORTED_LANGUAGES } from '../i18n';
import { apiFetch } from '../lib/api';

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
  /** Optional "Per il condimento"/"Per l'impasto" style group header — see
   *  RecipeIngredientInput.groupName in recipes.local.ts. */
  groupName?: string | null;
}

interface StepIngredientRef {
  ingredientSortOrder: number;
  amountMode?: 'fraction' | 'absolute';
  portion: number;
  quantity?: number | null;
  unitId?: string | null;
  unitSymbol?: string | null;
  notes?: string;
}

interface Step {
  id: string;
  stepNumber: number;
  title: string | null;
  description: string;
  durationMin: number | null;
  toolIds: string[];
  techniqueIds: string[];
  notes: string | null;
  imageUrl: string | null;
  stepIngredients: StepIngredientRef[];
  translations: TranslationEntry[];
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
  regions: string[];
  region_coords: Record<string, { lat: number; lng: number }>;
  yield_amount: number | null;
  yield_unit_id: string | null;
  cover_image_url: string | null;
  source_url: string | null;
  sources: RecipeSourceEntry[];
  is_component: boolean;
  language_code: string;
  translations: TranslationEntry[];
  ingredients: Ingredient[];
  steps: Step[];
  tools: Tool[];
}

const difficultyKey: Record<string, string> = {
  easy: 'gallery.difficultyEasy', medium: 'gallery.difficultyIntermediate',
  hard: 'gallery.difficultyAdvanced', expert: 'gallery.difficultyExpert',
};

const RecipeCreate: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const isOnline = useOnlineStatus();

  // Library data
  const contentLang = useStore((s) => s.contentLang);
  const langQuery = contentLang ? `?lang=${contentLang}` : '';
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [allUnits, setAllUnits] = useState<{ id: string; name: string; symbol: string; translated_name?: string | null }[]>([]);
  const [allIngredients, setAllIngredients] = useState<{ id: string; name: string; translated_name?: string | null }[]>([]);
  const [allTechniques, setAllTechniques] = useState<{ id: string; name: string; icon: string | null; translated_name?: string | null }[]>([]);
  const [allRecipes, setAllRecipes] = useState<{ id: string; title: string; translated_title?: string | null }[]>([]);
  // Per-row "Ingredient" vs "Recipe" toggle for the ingredient picker — not
  // persisted, purely a UI switch between the two Autocomplete data sources.
  const [ingredientEntryTypes, setIngredientEntryTypes] = useState<Record<number, 'ingredient' | 'recipe'>>({});

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
    regions: [],
    region_coords: {},
    yield_amount: null,
    yield_unit_id: null,
    cover_image_url: '',
    sources: [],
    is_component: false,
    language_code: contentLang || 'en',
    translations: [],
    ingredients: [],
    steps: [],
    tools: [],
  });

  /* ── Fetch library data ────────────────────────── */
  useEffect(() => {
    (async () => {
      try {
        const [tRes, uRes, iRes, techRes, rRes] = await Promise.all([
          apiFetch(`/api/tools${langQuery}`),
          apiFetch(`/api/units${langQuery}`),
          apiFetch(`/api/ingredients${langQuery}`),
          apiFetch(`/api/techniques${langQuery}`),
          apiFetch(`/api/recipes${langQuery}`),
        ]);
        const [tJson, uJson, iJson, techJson, rJson] = await Promise.all([tRes.json(), uRes.json(), iRes.json(), techRes.json(), rRes.json()]);
        setAllTools(tJson.data || []);
        setAllUnits(uJson.data || []);
        setAllIngredients(iJson.data || []);
        setAllTechniques(techJson.data || []);
        setAllRecipes(rJson.data || []);
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
      steps: [...(prev.steps || []), { id: '', stepNumber: (prev.steps?.length || 0) + 1, title: '', description: '', durationMin: null, toolIds: [], techniqueIds: [], notes: '', imageUrl: null, stepIngredients: [], translations: [] }],
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
            : [...existing, { ingredientSortOrder, amountMode: 'fraction' as const, portion: 1 }],
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

  // Switches a step-ingredient between "% of total" and "exact amount" mode.
  const setStepIngredientMode = (stepIdx: number, ingredientSortOrder: number, amountMode: 'fraction' | 'absolute') =>
    setDraft(prev => ({
      ...prev,
      steps: (prev.steps || []).map((s, i) => i === stepIdx ? {
        ...s,
        stepIngredients: (s.stepIngredients || []).map(si =>
          si.ingredientSortOrder === ingredientSortOrder ? { ...si, amountMode } : si
        ),
      } : s),
    }));

  const updateStepIngredientAmount = (stepIdx: number, ingredientSortOrder: number, field: 'quantity' | 'unitId' | 'unitSymbol', value: unknown) =>
    setDraft(prev => ({
      ...prev,
      steps: (prev.steps || []).map((s, i) => i === stepIdx ? {
        ...s,
        stepIngredients: (s.stepIngredients || []).map(si =>
          si.ingredientSortOrder === ingredientSortOrder ? { ...si, [field]: value } : si
        ),
      } : s),
    }));

  // Adds (or updates the amount of) a step ingredient — unlike
  // toggleStepIngredient this never removes, used when inserting an inline
  // {{ing:N}} reference from the step text toolbar.
  const setStepIngredient = (stepIdx: number, ingredientSortOrder: number, amount: StepIngredientAmount) =>
    setDraft(prev => ({
      ...prev,
      steps: (prev.steps || []).map((s, i) => {
        if (i !== stepIdx) return s;
        const existing = s.stepIngredients || [];
        const has = existing.some(si => si.ingredientSortOrder === ingredientSortOrder);
        const patch = {
          amountMode: amount.amountMode,
          portion: amount.portion ?? 1,
          quantity: amount.quantity ?? null,
          unitId: amount.unitId ?? null,
          unitSymbol: amount.unitSymbol ?? null,
        };
        return {
          ...s,
          stepIngredients: has
            ? existing.map(si => si.ingredientSortOrder === ingredientSortOrder ? { ...si, ...patch } : si)
            : [...existing, { ingredientSortOrder, ...patch }],
        };
      }),
    }));

  // Adds a tool reference to a step and, if it isn't already in the
  // dedicated Tools section, flags it there too — inline step references
  // and the recipe's tool list stay in sync.
  const addToolToStep = (stepIdx: number, toolId: string) =>
    setDraft(prev => {
      const alreadySelected = (prev.tools || []).some(t => t.id === toolId);
      const tool = allTools.find(t => t.id === toolId);
      return {
        ...prev,
        tools: !alreadySelected && tool ? [...(prev.tools || []), tool] : prev.tools,
        steps: (prev.steps || []).map((s, i) => i === stepIdx && !(s.toolIds || []).includes(toolId)
          ? { ...s, toolIds: [...(s.toolIds || []), toolId] }
          : s),
      };
    });

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
      ingredients: [...(prev.ingredients || []), { id: '', sortOrder: (prev.ingredients?.length || 0), ingredientId: null, ingredientName: '', quantity: 1, unitId: null, isOptional: false, notes: '', groupName: null }],
    }));

  const getEntryType = (idx: number, ing: Ingredient): 'ingredient' | 'recipe' =>
    ingredientEntryTypes[idx] ?? (ing.subRecipeId ? 'recipe' : 'ingredient');

  const setEntryType = (idx: number, type: 'ingredient' | 'recipe') => {
    setIngredientEntryTypes(prev => ({ ...prev, [idx]: type }));
    if (type === 'recipe') {
      updateIngredient(idx, 'ingredientId', null);
      updateIngredient(idx, 'ingredientName', '');
    } else {
      updateIngredient(idx, 'subRecipeId', null);
      updateIngredient(idx, 'subRecipeTitle', null);
    }
  };

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
      if (exists) {
        return {
          ...prev,
          tools: tools.filter(t => t.id !== tool.id),
          // Deselecting a tool removes it from any step that referenced it,
          // so it can't be silently dropped from recipe_tools on save while
          // a step still shows it as used.
          steps: (prev.steps || []).map(s => ({
            ...s,
            toolIds: (s.toolIds || []).filter(id => id !== tool.id),
          })),
        };
      }
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
        regions: draft.regions || [],
        regionCoords: draft.region_coords || {},
        yieldAmount: draft.yield_amount || undefined,
        yieldUnitId: draft.yield_unit_id || undefined,
        coverImageUrl: draft.cover_image_url || null,
        sourceUrl: draft.source_url || null,
        sources: draft.sources || [],
        isComponent: draft.is_component || false,
        languageCode: draft.language_code || contentLang || undefined,
        translations: draft.translations || [],
        ingredients: (draft.ingredients || []).map((ing, i) => ({
          sortOrder: i,
          ingredientId: ing.ingredientId || undefined,
          subRecipeId: ing.subRecipeId || undefined,
          quantity: ing.quantity || undefined,
          quantityText: ing.quantityText || undefined,
          unitId: ing.unitId || undefined,
          isOptional: ing.isOptional || false,
          notes: ing.notes || undefined,
          groupName: ing.groupName || undefined,
        })),
        steps: (draft.steps || []).map((s, i) => ({
          stepNumber: i + 1,
          title: s.title || undefined,
          description: s.description,
          durationMin: s.durationMin || undefined,
          toolIds: s.toolIds || [],
          techniqueIds: s.techniqueIds || [],
          notes: s.notes || undefined,
          imageUrl: s.imageUrl || null,
          stepIngredients: s.stepIngredients || [],
          translations: s.translations || [],
        })),
        toolIds: (draft.tools || []).map(t => t.id),
      };

      const res = await apiFetch('/api/recipes', {
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
        window.alert(t('recipeCreate.failedToCreate', { error: errMsg }));
        setSaving(false);
      }
    } catch (err) {
      console.error('RecipeCreate: Save request failed:', err);
      window.alert(t('recipeCreate.failedToConnect'));
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#fafaf5] font-body">
      {/* Header */}
      <header className="bg-[#fafaf5]/90 backdrop-blur-md sticky top-0 z-50 border-b border-zinc-200/60 px-8 py-4 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 text-zinc-500 hover:text-zinc-800 transition-colors">
          <span className="material-symbols-outlined">close</span>
          <span className="text-sm font-bold">{t('common.cancel')}</span>
        </Link>
        <h2 className="text-lg font-headline font-bold text-zinc-800">{t('recipeCreate.newRecipe')}</h2>
        <button
          onClick={handleSave}
          disabled={saving || !draft.title}
          className="flex items-center gap-2 px-5 py-2 bg-primary text-white rounded-full font-bold text-sm hover:bg-primary/90 transition-all disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">{saving ? 'sync' : 'add'}</span>
          {saving ? t('recipeCreate.creating') : t('recipeCreate.createRecipe')}
        </button>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10 space-y-8">
        {/* Title & description */}
        <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <label className="block mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold block">{t('recipeDetail.recipeTitle')}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-400 font-medium">
                {t('recipeDetail.writtenIn')}
                <select
                  value={draft.language_code || 'en'}
                  onChange={e => updateDraft('language_code', e.target.value)}
                  className="border-none bg-zinc-50 rounded-lg px-2 py-1 text-[11px] font-bold text-zinc-600 focus:ring-2 focus:ring-primary/20 cursor-pointer"
                >
                  {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </span>
            </div>
            <input
              type="text" value={draft.title || ''}
              onChange={e => updateDraft('title', e.target.value)}
              className="w-full text-3xl font-headline font-bold border-none bg-transparent focus:ring-0 p-0 placeholder:text-zinc-300"
              placeholder={t('recipeDetail.enterTitlePlaceholder')}
            />
          </label>
          <label className="block mb-6">
            <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">{t('recipeDetail.description')}</span>
            <textarea
              value={draft.description || ''}
              onChange={e => updateDraft('description', e.target.value)}
              className="w-full border-none bg-zinc-50 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[80px]"
              placeholder={t('recipeDetail.shortDescriptionPlaceholder')}
            />
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">{t('recipeDetail.coverImage')}</span>
            <ImageUrlInput
              value={draft.cover_image_url || ''}
              onChange={url => updateDraft('cover_image_url', url)}
            />
          </label>
        </div>

        {/* Translations */}
        <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <h3 className="font-headline font-bold text-xl mb-2">{t('recipeDetail.translations')}</h3>
          <p className="text-xs text-zinc-400 mb-6">{t('recipeDetail.translationsHint')}</p>
          <TranslationsEditor
            translations={draft.translations || []}
            onChange={translations => updateDraft('translations', translations)}
          />
        </div>

        {/* Metadata grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: t('recipeDetail.servings'), field: 'servings', type: 'number' },
            { label: t('recipeDetail.prepMin'), field: 'prep_time_min', type: 'number' },
            { label: t('recipeDetail.cookMin'), field: 'cook_time_min', type: 'number' },
            { label: t('recipeDetail.restMin'), field: 'rest_time_min', type: 'number' },
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

        {/* Yield (optional — enables weight/volume amounts when this recipe is used as a sub-recipe ingredient) */}
        <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <h3 className="font-headline font-bold text-xl mb-2">{t('recipeDetail.yield')}</h3>
          <p className="text-xs text-zinc-400 mb-4">{t('recipeDetail.yieldHint')}</p>
          <div className="flex gap-3 max-w-sm">
            <input
              type="number" step="any" value={draft.yield_amount ?? ''}
              onChange={e => updateDraft('yield_amount', e.target.value ? parseFloat(e.target.value) : null)}
              placeholder={t('recipeDetail.yieldAmountPlaceholder')}
              className="flex-1 border-none bg-zinc-50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20"
            />
            <select
              value={draft.yield_unit_id || ''}
              onChange={e => updateDraft('yield_unit_id', e.target.value || null)}
              className="border-none bg-zinc-50 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20"
            >
              <option value="">{t('recipeDetail.unitEllipsis')}</option>
              {allUnits.map(u => <option key={u.id} value={u.id}>{u.symbol} ({u.translated_name || u.name})</option>)}
            </select>
          </div>
        </div>

        {/* Difficulty + Tags */}
        <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex flex-wrap gap-6">
            <label>
              <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">{t('recipeDetail.difficulty')}</span>
              <select
                value={draft.difficulty || 'medium'}
                onChange={e => updateDraft('difficulty', e.target.value)}
                className="border-none bg-zinc-50 rounded-xl px-4 py-3 font-medium text-sm focus:ring-2 focus:ring-primary/20"
              >
                {['easy','medium','hard','expert'].map(d => (
                  <option key={d} value={d}>{t(difficultyKey[d])}</option>
                ))}
              </select>
            </label>
            <div className="flex-1 min-w-[200px]">
              <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">{t('recipeDetail.tags')}</span>
              <TagPicker value={draft.tags || []} onChange={tags => updateDraft('tags', tags)} />
            </div>
          </div>
        </div>

        {/* Regions */}
        <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <h3 className="font-headline font-bold text-xl mb-2">{t('recipeDetail.regions')}</h3>
          <p className="text-xs text-zinc-400 mb-4">{t('recipeDetail.regionsHint')}</p>
          <RegionPicker
            value={draft.regions || []}
            onChange={regions => updateDraft('regions', regions)}
            coords={draft.region_coords || {}}
            onCoordsChange={coords => updateDraft('region_coords', coords)}
          />
          {isOnline && (draft.regions || []).length > 0 && (
            <div className="mt-4">
              <RegionsMap regions={draft.regions || []} coords={draft.region_coords || {}} />
            </div>
          )}
        </div>

        {/* Sources & References */}
        <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <h3 className="font-headline font-bold text-xl mb-6">{t('recipeDetail.sourcesReferences')}</h3>
          <RecipeSourcesEditor
            sources={draft.sources || []}
            onChange={sources => updateDraft('sources', sources)}
          />
        </div>

        {/* Kitchen Tools Selector */}
        <div className="bg-white rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <h3 className="font-headline font-bold text-xl mb-6">{t('recipeDetail.kitchenTools')}</h3>
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
            <h3 className="font-headline font-bold text-xl">{t('recipeDetail.ingredients')}</h3>
            <button onClick={addIngredient} className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-full text-sm font-bold hover:bg-primary/90 transition-colors">
              <span className="material-symbols-outlined text-sm">add</span> {t('recipeDetail.addIngredient')}
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
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-[10px] uppercase font-bold text-zinc-400">{t('recipeDetail.ingredient')}</label>
                      <div className="flex bg-zinc-100 rounded-full p-0.5">
                        {(['ingredient', 'recipe'] as const).map((type) => (
                          <button
                            key={type}
                            type="button"
                            onClick={() => setEntryType(idx, type)}
                            className={`px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase transition-colors ${
                              getEntryType(idx, ing) === type ? 'bg-primary text-white' : 'text-zinc-400 hover:text-zinc-600'
                            }`}
                          >
                            {type === 'ingredient' ? t('recipeDetail.entryTypeIngredient') : t('recipeDetail.entryTypeRecipe')}
                          </button>
                        ))}
                      </div>
                    </div>
                    {getEntryType(idx, ing) === 'recipe' ? (
                      <Autocomplete
                        value={ing.subRecipeId || ''}
                        options={allRecipes.map(r => ({ id: r.id, label: r.translated_title || r.title }))}
                        onSelect={(id, label) => {
                          updateIngredient(idx, 'subRecipeId', id);
                          updateIngredient(idx, 'subRecipeTitle', label);
                        }}
                        onClear={() => {
                          updateIngredient(idx, 'subRecipeId', null);
                          updateIngredient(idx, 'subRecipeTitle', null);
                        }}
                        placeholder={t('recipeDetail.typeToSearch')}
                        className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      />
                    ) : (
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
                        placeholder={t('recipeDetail.typeToSearch')}
                        className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      />
                    )}
                    {getEntryType(idx, ing) === 'recipe' && (
                      <p className="text-[9px] text-zinc-400 mt-1">{t('recipeDetail.subRecipeCycleWarning')}</p>
                    )}
                  </div>
                  <div className="col-span-3">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.qty')}</label>
                    <input
                      type="number" step="any" value={ing.quantity || ''}
                      onChange={e => updateIngredient(idx, 'quantity', parseFloat(e.target.value))}
                      className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.unit')}</label>
                    <select
                      value={ing.unitId || ''}
                      onChange={e => {
                        const sym = allUnits.find(u => u.id === e.target.value)?.symbol || '';
                        updateIngredient(idx, 'unitId', e.target.value);
                        updateIngredient(idx, 'unitSymbol', sym);
                      }}
                      className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                    >
                      <option value="">{t('recipeDetail.unitEllipsis')}</option>
                      {allUnits.map(u => <option key={u.id} value={u.id}>{u.symbol} ({u.translated_name || u.name})</option>)}
                    </select>
                  </div>
                  <div className="col-span-6">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.groupOptional')}</label>
                    <input
                      type="text" value={ing.groupName || ''}
                      onChange={e => updateIngredient(idx, 'groupName', e.target.value || null)}
                      className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      placeholder={t('recipeDetail.groupPlaceholder')}
                    />
                  </div>
                  <div className="col-span-6">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.chefsNoteOptional')}</label>
                    <input
                      type="text" value={ing.notes || ''}
                      onChange={e => updateIngredient(idx, 'notes', e.target.value)}
                      className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      placeholder={t('recipeDetail.chefsNoteIngredientPlaceholder')}
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
            <h3 className="font-headline font-bold text-xl">{t('recipeDetail.steps')}</h3>
            <button onClick={addStep} className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-full text-sm font-bold hover:bg-primary/90 transition-colors">
              <span className="material-symbols-outlined text-sm">add</span> {t('recipeDetail.addStep')}
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
                    placeholder={t('recipeDetail.stepTitleOptional')}
                  />
                </div>
                <StepEditor
                  description={step.description}
                  onChangeDescription={text => updateStep(idx, 'description', text)}
                  ingredients={draft.ingredients || []}
                  tools={allTools}
                  units={allUnits}
                  techniques={allTechniques.map(t => ({ id: t.id, name: t.translated_name || t.name }))}
                  onInsertIngredient={(sortOrder, amount) => setStepIngredient(idx, sortOrder, amount)}
                  onInsertTool={(toolId) => addToolToStep(idx, toolId)}
                />
                <div className="mt-3">
                  <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.stepPhotoOptional')}</label>
                  <ImageUrlInput
                    value={step.imageUrl || ''}
                    onChange={url => updateStep(idx, 'imageUrl', url || null)}
                    className="flex-1 min-w-0 border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                <div className="mt-3">
                  <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.stepTranslationsOptional')}</label>
                  <TranslationsEditor
                    translations={step.translations || []}
                    onChange={translations => updateStep(idx, 'translations', translations)}
                    titleLabel={t('recipeDetail.stepTitle')}
                    descriptionLabel={t('recipeDetail.stepDescription')}
                    compact
                  />
                </div>
                <textarea
                  value={step.notes || ''}
                  onChange={e => updateStep(idx, 'notes', e.target.value)}
                  className="w-full mt-3 border border-dashed border-primary/20 bg-primary/5 rounded-xl p-3 text-xs italic resize-none focus:ring-2 focus:ring-primary/20 min-h-[60px]"
                  placeholder={t('recipeDetail.chefsNoteStepPlaceholder')}
                />

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.durationMin')}</label>
                    <input
                      type="number" value={step.durationMin || ''}
                      onChange={e => updateStep(idx, 'durationMin', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      placeholder={t('recipeDetail.min')}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.toolsForThisStep')}</label>
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

                {allTechniques.length > 0 && (
                  <div className="mt-4">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.techniquesForThisStep')}</label>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {allTechniques.map(tech => {
                        const isUsed = (step.techniqueIds || []).includes(tech.id);
                        return (
                          <button
                            key={tech.id}
                            onClick={() => {
                              const current = step.techniqueIds || [];
                              const next = current.includes(tech.id) ? current.filter(id => id !== tech.id) : [...current, tech.id];
                              updateStep(idx, 'techniqueIds', next);
                            }}
                            className={`p-1.5 rounded-lg border transition-all ${
                              isUsed ? 'bg-primary text-white border-primary' : 'bg-white text-zinc-400 border-zinc-100 hover:border-zinc-300'
                            }`}
                            title={tech.translated_name || tech.name}
                          >
                            <RenderFaIcon name={tech.icon || 'FaFire'} className="text-lg" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {(draft.ingredients || []).length > 0 && (
                  <div className="mt-4">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.ingredientsUsedInStep')}</label>
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
                              {ing.ingredientName || t('recipeDetail.unnamedIngredient')}
                              {ing.quantity ? ` (${ing.quantity}${ing.unitSymbol ? ' ' + ing.unitSymbol : ''} total)` : ''}
                            </button>
                            {isUsed && (
                              <>
                                <div className="flex bg-white rounded-lg p-0.5 border border-zinc-100 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => setStepIngredientMode(idx, ing.sortOrder, 'fraction')}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${(ref!.amountMode || 'fraction') === 'fraction' ? 'bg-primary text-white' : 'text-zinc-400'}`}
                                  >%</button>
                                  <button
                                    type="button"
                                    onClick={() => setStepIngredientMode(idx, ing.sortOrder, 'absolute')}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${ref!.amountMode === 'absolute' ? 'bg-primary text-white' : 'text-zinc-400'}`}
                                  >{t('recipeDetail.amt')}</button>
                                </div>
                                {(ref!.amountMode || 'fraction') === 'fraction' ? (
                                  <>
                                    <input
                                      type="range" min="0.05" max="1" step="0.05"
                                      value={ref!.portion}
                                      onChange={e => updateStepIngredientPortion(idx, ing.sortOrder, parseFloat(e.target.value))}
                                      className="w-24 accent-primary"
                                    />
                                    <span className="text-[10px] font-bold text-zinc-500 w-10 text-right">{Math.round(ref!.portion * 100)}%</span>
                                  </>
                                ) : (
                                  <>
                                    <input
                                      type="number" step="any" value={ref!.quantity ?? ''}
                                      onChange={e => updateStepIngredientAmount(idx, ing.sortOrder, 'quantity', e.target.value ? parseFloat(e.target.value) : null)}
                                      className="w-14 border-none bg-white rounded px-2 py-1 text-xs focus:ring-2 focus:ring-primary/20"
                                    />
                                    <select
                                      value={ref!.unitId || ''}
                                      onChange={e => {
                                        const sym = allUnits.find(u => u.id === e.target.value)?.symbol || '';
                                        updateStepIngredientAmount(idx, ing.sortOrder, 'unitId', e.target.value || null);
                                        updateStepIngredientAmount(idx, ing.sortOrder, 'unitSymbol', sym);
                                      }}
                                      className="w-16 border-none bg-white rounded px-1 py-1 text-[10px] focus:ring-2 focus:ring-primary/20"
                                    >
                                      <option value="">{t('recipeDetail.unitEllipsis')}</option>
                                      {allUnits.map(u => <option key={u.id} value={u.id}>{u.symbol}</option>)}
                                    </select>
                                  </>
                                )}
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
