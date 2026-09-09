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
import { coerceIngredients, coerceSteps, coerceNamedEntities } from '../lib/recipeDraftCoercion';

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
  /** How to store leftovers ("Come conservare"). */
  storage_instructions: string | null;
  /** General tips/notes distinct from description ("Consigli"). */
  tips: string | null;
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

  // Raw-text edit: same JSON-over-`draft` alternative to the GUI form
  // already offered on the edit-existing-recipe screen (RecipeDetail.tsx) —
  // ported here so a brand-new recipe can be pasted/bulk-edited as text too.
  const [rawTextMode, setRawTextMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawTextError, setRawTextError] = useState<string | null>(null);

  // Library data
  const contentLang = useStore((s) => s.contentLang);
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [allUnits, setAllUnits] = useState<{ id: string; name: string; symbol: string; translated_name?: string | null }[]>([]);
  const [allIngredients, setAllIngredients] = useState<{ id: string; name: string; translated_name?: string | null }[]>([]);
  const [allTechniques, setAllTechniques] = useState<{ id: string; name: string; icon: string | null; translated_name?: string | null }[]>([]);
  const [allRecipes, setAllRecipes] = useState<{ id: string; title: string; translated_title?: string | null }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; translated_name?: string | null }[]>([]);
  // Per-row "Ingredient" vs "Recipe" toggle for the ingredient picker — not
  // persisted, purely a UI switch between the two Autocomplete data sources.
  const [ingredientEntryTypes, setIngredientEntryTypes] = useState<Record<number, 'ingredient' | 'recipe'>>({});
  // Inline "create new ingredient" prompt (Autocomplete's onCreateNew) — set
  // while a row is waiting for the user to pick a category before the new
  // ingredient is actually created, so creating one doesn't require leaving
  // this page for the ingredient library screen.
  const [pendingIngredient, setPendingIngredient] = useState<{ idx: number; name: string; categoryId: string; pluralName: string; description: string } | null>(null);
  const [creatingPendingIngredient, setCreatingPendingIngredient] = useState(false);
  const [newToolName, setNewToolName] = useState('');
  const [newTechniqueName, setNewTechniqueName] = useState('');

  // Draft state
  const [draft, setDraft] = useState<Partial<Recipe>>({
    title: '',
    description: '',
    storage_instructions: null,
    tips: null,
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

  // The language the ingredient/tool/technique suggestion lists should be
  // shown in: the recipe's own language (the dropdown at the top of this
  // form, changeable independently of the app's own UI language), not
  // contentLang — otherwise writing a recipe in Italian while the app's UI
  // language is English left every suggestion showing its English name.
  const libraryLang = draft.language_code || contentLang;
  const langQuery = libraryLang ? `?lang=${libraryLang}` : '';

  /* ── Fetch library data ────────────────────────── */
  useEffect(() => {
    (async () => {
      try {
        const [tRes, uRes, iRes, techRes, rRes, catRes] = await Promise.all([
          apiFetch(`/api/tools${langQuery}`),
          apiFetch(`/api/units${langQuery}`),
          apiFetch(`/api/ingredients${langQuery}`),
          apiFetch(`/api/techniques${langQuery}`),
          apiFetch(`/api/recipes${langQuery}`),
          apiFetch(`/api/ingredients/categories${langQuery}`),
        ]);
        const [tJson, uJson, iJson, techJson, rJson, catJson] = await Promise.all([tRes.json(), uRes.json(), iRes.json(), techRes.json(), rRes.json(), catRes.json()]);
        setAllTools(tJson.data || []);
        setAllUnits(uJson.data || []);
        setAllIngredients(iJson.data || []);
        setAllTechniques(techJson.data || []);
        setAllRecipes(rJson.data || []);
        setCategories(catJson.data || []);
      } catch (err) {
        console.error('RecipeCreate: Library fetch failed:', err);
      }
    })();
  }, [libraryLang]);

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
  // An ingredient/sub-recipe reference whose id doesn't resolve to anything
  // in allIngredients/allRecipes (parsed from raw-text with only a name, or
  // pointing at something not yet loaded) — same search/create-new
  // treatment either way instead of an unexplained blank box.
  const ingredientNeedsMatching = (ing: Ingredient) =>
    (!ing.ingredientId && !!ing.ingredientName) ||
    (!!ing.ingredientId && !allIngredients.some(i => i.id === ing.ingredientId));
  const subRecipeDangling = (ing: Ingredient) =>
    !!ing.subRecipeId && !allRecipes.some(r => r.id === ing.subRecipeId);

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

  // Creates a brand-new ingredient without leaving the recipe editor —
  // Autocomplete's "Create '<query>'" row opens this two-step prompt
  // (name is already known, just need a category) instead of forcing a
  // trip to the ingredient library screen and back.
  const confirmCreateIngredient = async () => {
    if (!pendingIngredient || !pendingIngredient.categoryId) return;
    setCreatingPendingIngredient(true);
    try {
      const res = await apiFetch('/api/ingredients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: pendingIngredient.name,
          categoryId: pendingIngredient.categoryId,
          pluralName: pendingIngredient.pluralName || undefined,
          description: pendingIngredient.description || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('errors.couldNotCreateIngredient'));
      const newIngredient = { id: json.data.id, name: pendingIngredient.name };
      setAllIngredients(prev => [...prev, newIngredient]);
      updateIngredient(pendingIngredient.idx, 'ingredientId', newIngredient.id);
      updateIngredient(pendingIngredient.idx, 'ingredientName', newIngredient.name);
      setPendingIngredient(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t('errors.couldNotCreateIngredient'));
    } finally {
      setCreatingPendingIngredient(false);
    }
  };

  const createToolInline = async () => {
    const name = newToolName.trim();
    if (!name) return;
    try {
      const res = await apiFetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('errors.couldNotCreateTool'));
      const newTool: Tool = { id: json.data.id, name, icon: null };
      setAllTools(prev => [...prev, newTool]);
      setDraft(prev => ({ ...prev, tools: [...(prev.tools || []), newTool] }));
      setNewToolName('');
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t('errors.couldNotCreateTool'));
    }
  };

  const createTechniqueInline = async (onCreated: (id: string) => void) => {
    const name = newTechniqueName.trim();
    if (!name) return;
    try {
      const res = await apiFetch('/api/techniques', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('errors.couldNotCreateTechnique'));
      setAllTechniques(prev => [...prev, { id: json.data.id, name, icon: null }]);
      setNewTechniqueName('');
      onCreated(json.data.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t('errors.couldNotCreateTechnique'));
    }
  };

  /* ── Save logic ────────────────────────────────── */
  // Optional `overrideDraft` lets the raw-text toggle below hand in the
  // just-parsed JSON directly instead of reading `draft` — setDraft()'s
  // update wouldn't be visible yet in this same closure otherwise.
  const handleSave = async (overrideDraft?: Partial<Recipe>) => {
    const d = overrideDraft || draft;
    if (!d.title) return;
    setSaving(true);
    try {
      // Any tool not already in the library (pasted from raw-text JSON,
      // never confirmed via the Kitchen Tools grid above) gets created for
      // real now — its id up to this point was only a locally-generated
      // placeholder, not a real toolId the backend can save a reference to.
      const resolvedToolIds: string[] = [];
      for (const tool of d.tools || []) {
        if (allTools.some(at => at.id === tool.id)) {
          resolvedToolIds.push(tool.id);
          continue;
        }
        const res = await apiFetch('/api/tools', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tool.name }),
        });
        const json = await res.json();
        if (res.ok) resolvedToolIds.push(json.data.id);
      }

      const body = {
        title: d.title,
        description: d.description || '',
        storageInstructions: d.storage_instructions || undefined,
        tips: d.tips || undefined,
        difficulty: d.difficulty || 'medium',
        servings: d.servings || 4,
        prepTimeMin: d.prep_time_min || undefined,
        cookTimeMin: d.cook_time_min || undefined,
        restTimeMin: d.rest_time_min || undefined,
        tags: d.tags || [],
        regions: d.regions || [],
        regionCoords: d.region_coords || {},
        yieldAmount: d.yield_amount || undefined,
        yieldUnitId: d.yield_unit_id || undefined,
        coverImageUrl: d.cover_image_url || null,
        sourceUrl: d.source_url || null,
        sources: d.sources || [],
        isComponent: d.is_component || false,
        languageCode: d.language_code || contentLang || undefined,
        translations: d.translations || [],
        ingredients: (d.ingredients || []).map((ing, i) => ({
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
        steps: (d.steps || []).map((s, i) => ({
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
        toolIds: resolvedToolIds,
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
        const errMsg = json.error ? JSON.stringify(json.error) : t('errors.unknownError');
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

  const enterRawTextMode = () => {
    setRawText(JSON.stringify(draft, null, 2));
    setRawTextError(null);
    setRawTextMode(true);
  };
  // Returns the parsed draft (and leaves raw mode active with an error
  // shown) on invalid JSON — null in that case — so callers can bail out
  // instead of silently discarding whatever the user typed. Same pattern
  // as RecipeDetail.tsx's edit-mode raw-text toggle.
  const applyRawText = (): Partial<Recipe> | null => {
    try {
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Expected a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
      }
      // Merge onto the current draft rather than replacing it wholesale.
      // ingredients/steps/tools also accept the same looser shape the AI
      // import pipeline produces (steps as plain sentences, tools as plain
      // names, ingredients as {name, quantity, unit, note}) via
      // coerce*() below — anything that still isn't recognizable just
      // becomes an empty array instead of undefined, which is what used to
      // crash every .map() in the form below to a blank screen.
      const merged: Partial<Recipe> = { ...draft, ...parsed };
      if ('ingredients' in parsed) merged.ingredients = coerceIngredients(parsed.ingredients) as unknown as Ingredient[];
      if ('steps' in parsed) merged.steps = coerceSteps(parsed.steps) as unknown as Step[];
      if ('tools' in parsed) merged.tools = coerceNamedEntities(parsed.tools) as unknown as Tool[];
      const arrayFields: (keyof Recipe)[] = ['ingredients', 'steps', 'tools', 'tags', 'regions', 'sources', 'translations'];
      for (const field of arrayFields) {
        if (!Array.isArray(merged[field])) (merged as Record<string, unknown>)[field] = draft[field] ?? [];
      }
      setDraft(merged);
      setRawTextError(null);
      return merged;
    } catch (err) {
      setRawTextError(err instanceof Error ? err.message : t('errors.invalidJson'));
      return null;
    }
  };
  const toggleRawText = () => {
    if (rawTextMode) {
      if (!applyRawText()) return;
      setRawTextMode(false);
    } else {
      enterRawTextMode();
    }
  };
  const handleCreateClick = () => {
    if (rawTextMode) {
      const parsed = applyRawText();
      if (!parsed) return;
      setRawTextMode(false);
      handleSave(parsed);
      return;
    }
    handleSave();
  };

  return (
    <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 font-body">
      {/* Header */}
      <header className="bg-[#fafaf5]/90 dark:bg-zinc-950/90 backdrop-blur-md sticky top-0 z-50 border-b border-zinc-200/60 dark:border-zinc-700/60 px-8 py-4 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors">
          <span className="material-symbols-outlined">close</span>
          <span className="text-sm font-bold">{t('common.cancel')}</span>
        </Link>
        <h2 className="text-lg font-headline font-bold text-zinc-800 dark:text-zinc-200">{t('recipeCreate.newRecipe')}</h2>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleRawText}
            disabled={saving}
            title={rawTextMode ? t('recipeDetail.switchToForm') : t('recipeDetail.switchToRawText')}
            className="flex items-center gap-2 px-4 py-2 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-full font-bold text-sm transition-all disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">{rawTextMode ? 'edit_note' : 'code'}</span>
            {rawTextMode ? t('recipeDetail.switchToForm') : t('recipeDetail.switchToRawText')}
          </button>
          <button
            onClick={handleCreateClick}
            disabled={saving || (!rawTextMode && !draft.title)}
            className="flex items-center gap-2 px-5 py-2 bg-primary text-white rounded-full font-bold text-sm hover:bg-primary/90 transition-all disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">{saving ? 'sync' : 'add'}</span>
            {saving ? t('recipeCreate.creating') : t('recipeCreate.createRecipe')}
          </button>
        </div>
      </header>

      {rawTextMode ? (
        <main className="max-w-4xl mx-auto px-6 py-10 space-y-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('recipeDetail.rawTextEditHint')}</p>
          {rawTextError && (
            <p className="text-sm text-red-600 font-medium bg-red-50 rounded-xl px-4 py-3">{rawTextError}</p>
          )}
          <textarea
            value={rawText}
            onChange={e => setRawText(e.target.value)}
            spellCheck={false}
            className="w-full h-[70vh] rounded-3xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 font-mono text-xs leading-relaxed focus:ring-2 focus:ring-primary/20 focus:outline-none"
          />
        </main>
      ) : (
      <main className="max-w-6xl mx-auto px-6 py-10 space-y-8">
        {/* Title & description */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <label className="block mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold block">{t('recipeDetail.recipeTitle')}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">
                {t('recipeDetail.writtenIn')}
                <select
                  value={draft.language_code || 'en'}
                  onChange={e => updateDraft('language_code', e.target.value)}
                  className="border-none bg-zinc-50 dark:bg-zinc-900 rounded-lg px-2 py-1 text-[11px] font-bold text-zinc-600 dark:text-zinc-400 focus:ring-2 focus:ring-primary/20 cursor-pointer"
                >
                  {SUPPORTED_LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
                <a href="#translations-section" className="text-primary font-bold hover:underline whitespace-nowrap">{t('recipeDetail.addTitleTranslation')}</a>
              </span>
            </div>
            <input
              type="text" value={draft.title || ''}
              onChange={e => updateDraft('title', e.target.value)}
              className="w-full text-3xl font-headline font-bold border-none bg-transparent focus:ring-0 p-0 placeholder:text-zinc-300 dark:placeholder:text-zinc-600"
              placeholder={t('recipeDetail.enterTitlePlaceholder')}
            />
          </label>
          <label className="block mb-6">
            <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.description')}</span>
            <textarea
              value={draft.description || ''}
              onChange={e => updateDraft('description', e.target.value)}
              className="w-full border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[80px] max-h-[50vh] overflow-y-auto [field-sizing:content]"
              placeholder={t('recipeDetail.shortDescriptionPlaceholder')}
            />
          </label>
          <label className="block mb-6">
            <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.storageInstructions')}</span>
            <textarea
              value={draft.storage_instructions || ''}
              onChange={e => updateDraft('storage_instructions', e.target.value || null)}
              className="w-full border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[60px] max-h-[40vh] overflow-y-auto [field-sizing:content]"
              placeholder={t('recipeDetail.storageInstructionsPlaceholder')}
            />
          </label>
          <label className="block mb-6">
            <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.tips')}</span>
            <textarea
              value={draft.tips || ''}
              onChange={e => updateDraft('tips', e.target.value || null)}
              className="w-full border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[60px] max-h-[40vh] overflow-y-auto [field-sizing:content]"
              placeholder={t('recipeDetail.tipsPlaceholder')}
            />
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.coverImage')}</span>
            <ImageUrlInput
              value={draft.cover_image_url || ''}
              onChange={url => updateDraft('cover_image_url', url)}
            />
          </label>
        </div>

        {/* Translations */}
        <div id="translations-section" className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)] scroll-mt-24">
          <h3 className="font-headline font-bold text-xl mb-2">{t('recipeDetail.translations')}</h3>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-6">{t('recipeDetail.translationsHint')}</p>
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
            <label key={f.field} className="bg-white dark:bg-zinc-900 rounded-2xl p-5 shadow-[0_1px_6px_rgba(0,0,0,0.03)]">
              <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold block mb-2">{f.label}</span>
              <input
                type="number" value={String((draft as any)[f.field] || '')}
                onChange={e => updateDraft(f.field, e.target.value ? parseInt(e.target.value) : null)}
                className="w-full border-none bg-transparent text-2xl font-bold text-zinc-800 dark:text-zinc-200 p-0 focus:ring-0"
              />
            </label>
          ))}
        </div>

        {/* Yield (optional — enables weight/volume amounts when this recipe is used as a sub-recipe ingredient) */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <h3 className="font-headline font-bold text-xl mb-2">{t('recipeDetail.yield')}</h3>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-4">{t('recipeDetail.yieldHint')}</p>
          <div className="flex gap-3 max-w-sm">
            <input
              type="number" step="any" value={draft.yield_amount ?? ''}
              onChange={e => updateDraft('yield_amount', e.target.value ? parseFloat(e.target.value) : null)}
              placeholder={t('recipeDetail.yieldAmountPlaceholder')}
              className="flex-1 border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20"
            />
            <select
              value={draft.yield_unit_id || ''}
              onChange={e => updateDraft('yield_unit_id', e.target.value || null)}
              className="border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20"
            >
              <option value="">{t('recipeDetail.unitEllipsis')}</option>
              {allUnits.map(u => <option key={u.id} value={u.id}>{u.symbol} ({u.translated_name || u.name})</option>)}
            </select>
          </div>
        </div>

        {/* Difficulty + Tags */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex flex-wrap gap-6">
            <label>
              <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.difficulty')}</span>
              <select
                value={draft.difficulty || 'medium'}
                onChange={e => updateDraft('difficulty', e.target.value)}
                className="border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl px-4 py-3 font-medium text-sm focus:ring-2 focus:ring-primary/20"
              >
                {['easy','medium','hard','expert'].map(d => (
                  <option key={d} value={d}>{t(difficultyKey[d])}</option>
                ))}
              </select>
            </label>
            <div className="flex-1 min-w-[200px]">
              <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.tags')}</span>
              <TagPicker value={draft.tags || []} onChange={tags => updateDraft('tags', tags)} />
            </div>
          </div>
        </div>

        {/* Regions */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <h3 className="font-headline font-bold text-xl mb-2">{t('recipeDetail.regions')}</h3>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-4">{t('recipeDetail.regionsHint')}</p>
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
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <h3 className="font-headline font-bold text-xl mb-6">{t('recipeDetail.sourcesReferences')}</h3>
          <RecipeSourcesEditor
            sources={draft.sources || []}
            onChange={sources => updateDraft('sources', sources)}
          />
        </div>

        {/* Kitchen Tools Selector */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
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
                      : 'bg-zinc-50 dark:bg-zinc-900 border-zinc-100 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600'
                  }`}
                >
                  <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-lg" />
                  <span className="text-sm font-bold">{tool.translated_name || tool.name}</span>
                </button>
              );
            })}
            {/* Pasted-but-not-yet-in-the-library tools (e.g. from raw-text
                JSON) — otherwise invisible here since this grid only lists
                allTools, yet still silently in draft.tools and would fail
                to save as a real toolId. Shown so they can be reviewed/
                removed before saving auto-creates them for real. */}
            {(draft.tools || []).filter(t => !allTools.some(at => at.id === t.id)).map(tool => (
              <button
                key={tool.id}
                onClick={() => toggleTool(tool)}
                title={t('recipeDetail.ingredientNeedsMatching')}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400"
              >
                <RenderFaIcon name="FaKitchenSet" className="text-lg" />
                <span className="text-sm font-bold">{tool.name}</span>
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            ))}
          </div>
          <div className="flex gap-2 mt-4">
            <input
              type="text"
              value={newToolName}
              onChange={(e) => setNewToolName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createToolInline(); } }}
              placeholder={t('recipeDetail.newToolPlaceholder')}
              className="flex-1 border-none bg-zinc-50 dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="button"
              onClick={createToolInline}
              disabled={!newToolName.trim()}
              className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-bold disabled:opacity-50"
            >
              {t('recipeDetail.addTool')}
            </button>
          </div>
        </div>

        {/* Ingredients Editor */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-headline font-bold text-xl">{t('recipeDetail.ingredients')}</h3>
            <button onClick={addIngredient} className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-full text-sm font-bold hover:bg-primary/90 transition-colors">
              <span className="material-symbols-outlined text-sm">add</span> {t('recipeDetail.addIngredient')}
            </button>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {(draft.ingredients || []).map((ing, idx) => (
              /* @container: the fields inside lay themselves out from the CARD's
                 width rather than the viewport's. Two of these sit side by side in
                 an 8-of-12 column, so the old viewport-wide `xl:` 6/3/3 grid left
                 the ingredient name about 170px - name, type toggle, QTY and UNIT
                 all printing over each other. */
              <div key={idx} className="@container bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl p-4 border border-zinc-100 dark:border-zinc-800">
                {/* Type toggle and delete get their own row. The toggle used to share
                    a line with the "Ingredient" label and ran straight through it,
                    and delete was an absolutely-positioned button lying on top of
                    the name field, invisible until hover. */}
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded-full p-0.5">
                    {(['ingredient', 'recipe'] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setEntryType(idx, type)}
                        className={`px-3 py-1 rounded-full text-[9px] font-bold uppercase transition-colors ${
                          getEntryType(idx, ing) === type ? 'bg-primary text-white' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400'
                        }`}
                      >
                        {type === 'ingredient' ? t('recipeDetail.entryTypeIngredient') : t('recipeDetail.entryTypeRecipe')}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => removeIngredient(idx)}
                    title={t('common.delete')}
                    className="w-8 h-8 shrink-0 rounded-full text-zinc-300 dark:text-zinc-600 flex items-center justify-center transition-colors hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-500"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
                <div className="grid grid-cols-12 gap-3">
                  <div className="col-span-12 @lg:col-span-6">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.ingredient')}</label>
                    {getEntryType(idx, ing) === 'recipe' ? (
                      <Autocomplete
                        value={subRecipeDangling(ing) ? '' : (ing.subRecipeId || '')}
                        unmatchedLabel={subRecipeDangling(ing) ? (ing.subRecipeTitle || t('recipeDetail.ingredientNeedsMatching')) : undefined}
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
                        className={`w-full rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 ${
                          subRecipeDangling(ing)
                            ? 'border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700'
                            : 'border-none bg-white dark:bg-zinc-900'
                        }`}
                      />
                    ) : (
                      <Autocomplete
                        value={ingredientNeedsMatching(ing) ? '' : (ing.ingredientId || '')}
                        unmatchedLabel={ingredientNeedsMatching(ing) ? (ing.ingredientName || t('recipeDetail.ingredientNeedsMatching')) : undefined}
                        options={allIngredients.map(i => ({ id: i.id, label: i.translated_name || i.name }))}
                        onSelect={(id, label) => {
                          updateIngredient(idx, 'ingredientId', id);
                          updateIngredient(idx, 'ingredientName', label);
                        }}
                        onClear={() => {
                          updateIngredient(idx, 'ingredientId', null);
                          updateIngredient(idx, 'ingredientName', '');
                        }}
                        onCreateNew={(name) => setPendingIngredient({ idx, name, categoryId: categories[0]?.id || '', pluralName: '', description: '' })}
                        createNewLabel={(name) => t('import.createNew', { name })}
                        placeholder={t('recipeDetail.typeToSearch')}
                        className={`w-full rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20 ${
                          ingredientNeedsMatching(ing)
                            ? 'border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700'
                            : 'border-none bg-white dark:bg-zinc-900'
                        }`}
                      />
                    )}
                    {ingredientNeedsMatching(ing) && getEntryType(idx, ing) === 'ingredient' && (
                      <p className="text-[9px] text-amber-600 dark:text-amber-500 font-bold mt-1">{t('recipeDetail.ingredientNeedsMatching')}</p>
                    )}
                    {getEntryType(idx, ing) === 'recipe' && (
                      <p className="text-[9px] text-zinc-400 dark:text-zinc-500 mt-1">{t('recipeDetail.subRecipeCycleWarning')}</p>
                    )}
                    {pendingIngredient?.idx === idx && (
                      <div className="mt-2 bg-primary/5 border border-primary/20 rounded-lg p-3 space-y-2">
                        <div>
                          <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.ingredient')}</label>
                          <input
                            type="text"
                            value={pendingIngredient.name}
                            onChange={(e) => setPendingIngredient({ ...pendingIngredient, name: e.target.value })}
                            className="w-full text-xs bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1.5"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('import.pickCategory')}</label>
                            <select
                              value={pendingIngredient.categoryId}
                              onChange={(e) => setPendingIngredient({ ...pendingIngredient, categoryId: e.target.value })}
                              className="w-full text-xs bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1.5"
                            >
                              <option value="">{t('import.pickCategory')}</option>
                              {categories.map(c => (
                                <option key={c.id} value={c.id}>{c.translated_name || c.name}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.pluralOptional')}</label>
                            <input
                              type="text"
                              value={pendingIngredient.pluralName}
                              onChange={(e) => setPendingIngredient({ ...pendingIngredient, pluralName: e.target.value })}
                              placeholder={t('recipeDetail.pluralPlaceholder')}
                              className="w-full text-xs bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1.5"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.descriptionOptional')}</label>
                          <input
                            type="text"
                            value={pendingIngredient.description}
                            onChange={(e) => setPendingIngredient({ ...pendingIngredient, description: e.target.value })}
                            className="w-full text-xs bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1.5"
                          />
                        </div>
                        <p className="text-[9px] text-zinc-400 dark:text-zinc-500">{t('recipeDetail.moreDetailsLaterHint')}</p>
                        <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          disabled={!pendingIngredient.categoryId || !pendingIngredient.name.trim() || creatingPendingIngredient}
                          onClick={confirmCreateIngredient}
                          className="px-3 py-1.5 rounded-lg bg-primary text-white text-[11px] font-bold disabled:opacity-50"
                        >
                          {creatingPendingIngredient ? '…' : t('import.createNew', { name: pendingIngredient.name })}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingIngredient(null)}
                          className="px-2 py-1.5 rounded-lg text-zinc-400 dark:text-zinc-500 text-[11px] font-bold hover:text-zinc-600 dark:hover:text-zinc-400"
                        >
                          {t('common.cancel')}
                        </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="col-span-5 @lg:col-span-3">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.qty')}</label>
                    <input
                      type="number" step="any" value={ing.quantity || ''}
                      onChange={e => updateIngredient(idx, 'quantity', parseFloat(e.target.value))}
                      className="w-full border-none bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="col-span-7 @lg:col-span-3">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.unit')}</label>
                    <select
                      value={ing.unitId || ''}
                      onChange={e => {
                        const sym = allUnits.find(u => u.id === e.target.value)?.symbol || '';
                        updateIngredient(idx, 'unitId', e.target.value);
                        updateIngredient(idx, 'unitSymbol', sym);
                      }}
                      className="w-full border-none bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                    >
                      <option value="">{t('recipeDetail.unitEllipsis')}</option>
                      {allUnits.map(u => <option key={u.id} value={u.id}>{u.symbol} ({u.translated_name || u.name})</option>)}
                    </select>
                  </div>
                  <div className="col-span-12 @lg:col-span-6">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.groupOptional')}</label>
                    <input
                      type="text" value={ing.groupName || ''}
                      onChange={e => updateIngredient(idx, 'groupName', e.target.value || null)}
                      className="w-full border-none bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      placeholder={t('recipeDetail.groupPlaceholder')}
                    />
                  </div>
                  <div className="col-span-12 @lg:col-span-6">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.chefsNoteOptional')}</label>
                    <input
                      type="text" value={ing.notes || ''}
                      onChange={e => updateIngredient(idx, 'notes', e.target.value)}
                      className="w-full border-none bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      placeholder={t('recipeDetail.chefsNoteIngredientPlaceholder')}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Steps editor */}
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-headline font-bold text-xl">{t('recipeDetail.steps')}</h3>
            <button onClick={addStep} className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-full text-sm font-bold hover:bg-primary/90 transition-colors">
              <span className="material-symbols-outlined text-sm">add</span> {t('recipeDetail.addStep')}
            </button>
          </div>
          <div className="space-y-4">
            {(draft.steps || []).map((step, idx) => (
              <div key={idx} className="bg-zinc-50 dark:bg-zinc-900 rounded-2xl p-6 relative group border border-zinc-100 dark:border-zinc-800">
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
                  <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.stepPhotoOptional')}</label>
                  <ImageUrlInput
                    value={step.imageUrl || ''}
                    onChange={url => updateStep(idx, 'imageUrl', url || null)}
                    className="flex-1 min-w-0 border-none bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                <div className="mt-3">
                  <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.stepTranslationsOptional')}</label>
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
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.durationMin')}</label>
                    <input
                      type="number" value={step.durationMin || ''}
                      onChange={e => updateStep(idx, 'durationMin', e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full border-none bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                      placeholder={t('recipeDetail.min')}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.toolsForThisStep')}</label>
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
                              isUsed ? 'bg-primary text-white border-primary' : 'bg-white dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 border-zinc-100 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600'
                            }`}
                            title={tool.translated_name || tool.name}
                          >
                            <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-lg" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.techniquesForThisStep')}</label>
                  {allTechniques.length > 0 && (
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
                              isUsed ? 'bg-primary text-white border-primary' : 'bg-white dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 border-zinc-100 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600'
                            }`}
                            title={tech.translated_name || tech.name}
                          >
                            <RenderFaIcon name={tech.icon || 'TbFlame'} className="text-lg" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex gap-2 mt-2">
                    <input
                      type="text"
                      value={newTechniqueName}
                      onChange={(e) => setNewTechniqueName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          createTechniqueInline((newId) => updateStep(idx, 'techniqueIds', [...(step.techniqueIds || []), newId]));
                        }
                      }}
                      placeholder={t('recipeDetail.newTechniquePlaceholder')}
                      className="flex-1 border-none bg-zinc-50 dark:bg-zinc-900 rounded-lg px-3 py-1.5 text-xs focus:ring-2 focus:ring-primary/20"
                    />
                    <button
                      type="button"
                      onClick={() => createTechniqueInline((newId) => updateStep(idx, 'techniqueIds', [...(step.techniqueIds || []), newId]))}
                      disabled={!newTechniqueName.trim()}
                      className="px-3 py-1.5 rounded-lg bg-zinc-900 text-white text-[11px] font-bold disabled:opacity-50"
                    >
                      {t('recipeDetail.addTechnique')}
                    </button>
                  </div>
                </div>

                {(draft.ingredients || []).length > 0 && (
                  <div className="mt-4">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.ingredientsUsedInStep')}</label>
                    <div className="space-y-1.5 mt-1">
                      {(draft.ingredients || []).map(ing => {
                        const ref = (step.stepIngredients || []).find(si => si.ingredientSortOrder === ing.sortOrder);
                        const isUsed = !!ref;
                        return (
                          <div key={ing.sortOrder} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all ${isUsed ? 'bg-primary/5 border-primary/20' : 'bg-white dark:bg-zinc-900 border-zinc-100 dark:border-zinc-800'}`}>
                            <button
                              type="button"
                              onClick={() => toggleStepIngredient(idx, ing.sortOrder)}
                              className={`text-xs font-bold flex-1 text-left ${isUsed ? 'text-primary' : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400'}`}
                            >
                              {ing.ingredientName || t('recipeDetail.unnamedIngredient')}
                              {ing.quantity ? ` (${ing.quantity}${ing.unitSymbol ? ' ' + ing.unitSymbol : ''} total)` : ''}
                            </button>
                            {isUsed && (
                              <>
                                <div className="flex bg-white dark:bg-zinc-900 rounded-lg p-0.5 border border-zinc-100 dark:border-zinc-800 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => setStepIngredientMode(idx, ing.sortOrder, 'fraction')}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${(ref!.amountMode || 'fraction') === 'fraction' ? 'bg-primary text-white' : 'text-zinc-400 dark:text-zinc-500'}`}
                                  >%</button>
                                  <button
                                    type="button"
                                    onClick={() => setStepIngredientMode(idx, ing.sortOrder, 'absolute')}
                                    className={`px-1.5 py-0.5 rounded text-[9px] font-bold transition-colors ${ref!.amountMode === 'absolute' ? 'bg-primary text-white' : 'text-zinc-400 dark:text-zinc-500'}`}
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
                                    <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 w-10 text-right">{Math.round(ref!.portion * 100)}%</span>
                                  </>
                                ) : (
                                  <>
                                    <input
                                      type="number" step="any" value={ref!.quantity ?? ''}
                                      onChange={e => updateStepIngredientAmount(idx, ing.sortOrder, 'quantity', e.target.value ? parseFloat(e.target.value) : null)}
                                      className="w-14 border-none bg-white dark:bg-zinc-900 rounded px-2 py-1 text-xs focus:ring-2 focus:ring-primary/20"
                                    />
                                    <select
                                      value={ref!.unitId || ''}
                                      onChange={e => {
                                        const sym = allUnits.find(u => u.id === e.target.value)?.symbol || '';
                                        updateStepIngredientAmount(idx, ing.sortOrder, 'unitId', e.target.value || null);
                                        updateStepIngredientAmount(idx, ing.sortOrder, 'unitSymbol', sym);
                                      }}
                                      className="w-16 border-none bg-white dark:bg-zinc-900 rounded px-1 py-1 text-[10px] focus:ring-2 focus:ring-primary/20"
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
      )}
    </div>
  );
};

export default RecipeCreate;
