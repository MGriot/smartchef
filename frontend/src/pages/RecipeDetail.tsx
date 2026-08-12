import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/app.store';
import { SUPPORTED_LANGUAGES } from '../i18n';
import RenderFaIcon from '../components/RenderFaIcon';
import Autocomplete from '../components/Autocomplete';
import StepEditor, { StepIngredientAmount } from '../components/StepEditor';
import RecipeSourcesEditor, { RecipeSourceEntry, SOURCE_TYPE_META } from '../components/RecipeSourcesEditor';
import ImageUrlInput from '../components/ImageUrlInput';
import TranslationsEditor, { TranslationEntry } from '../components/TranslationsEditor';
import TagPicker from '../components/TagPicker';
import RenderStepText from '../components/RenderStepText';
import AppLayout from '../components/AppLayout';
import StarRating from '../components/StarRating';
import { apiFetch } from '../lib/api';

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
  translatedNotes?: string | null;
  translations?: TranslationEntry[];
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
  translatedTitle?: string | null;
  description: string;
  translatedDescription?: string | null;
  durationMin: number | null;
  toolIds: string[];
  notes: string | null;
  translatedNotes?: string | null;
  imageUrl: string | null;
  stepIngredients: StepIngredientRef[];
  translations: TranslationEntry[];
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
  rating: number | null;
  times_cooked: number;
  created_at: string;
  updated_at: string;
  tags: string[];
  tags_display?: { name: string; translated_name: string; color: string | null }[];
  cover_image_url: string;
  source_url: string | null;
  sources: RecipeSourceEntry[];
  is_component: boolean;
  language_code?: string | null;
  translations: TranslationEntry[];
  ingredients: Ingredient[];
  steps: Step[];
  tools: Tool[];
  creator_name?: string | null;
  creator_avatar_url?: string | null;
}

type PageMode = 'view' | 'edit' | 'cook';

/* ── Kitchen Mode: sub-recipes prepared before the main recipe ─────────── */
interface CookSequenceStep {
  id: string;
  stepNumber: number;
  title: string | null;
  description: string;
  durationMin: number | null;
  toolIds: string[];
  imageUrl: string | null;
  notes: string | null;
}
interface CookSequenceIngredientRef {
  sortOrder: number;
  ingredientName: string;
  quantity: number | null;
  unitSymbol: string | null;
}
interface CookSequenceToolRef {
  id: string;
  name: string;
  icon: string | null;
}
interface CookSequenceSection {
  recipeId: string;
  recipeTitle: string;
  isMain: boolean;
  steps: CookSequenceStep[];
  ingredients: CookSequenceIngredientRef[];
  tools: CookSequenceToolRef[];
}

/* ── Nutrition ───────────────────────────────────────────────────────── */
interface NutritionTotals {
  caloriesKcal: number; proteinG: number; carbsG: number; fatG: number;
  fiberG: number; sugarG: number; sodiumMg: number;
}
interface RecipeNutritionResult {
  requestedServings: number;
  totals: NutritionTotals;
  perServing: NutritionTotals;
  unresolved: string[];
}

/* ═══════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════ */
const difficultyKey: Record<string, string> = {
  easy: 'gallery.difficultyEasy', medium: 'gallery.difficultyIntermediate',
  hard: 'gallery.difficultyAdvanced', expert: 'gallery.difficultyExpert',
};

const formatTime = (min: number | null | undefined): string => {
  if (!min) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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
        const res = await apiFetch(`/api/recipes/${subRecipeId}`);
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
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const [addedToCart, setAddedToCart] = useState(false);
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [allCollections, setAllCollections] = useState<{ id: string; name: string }[]>([]);
  const [memberCollectionIds, setMemberCollectionIds] = useState<Set<string>>(new Set());
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [cookSequence, setCookSequence] = useState<CookSequenceSection[] | null>(null);
  const [nutrition, setNutrition] = useState<RecipeNutritionResult | null>(null);

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

  const openCollectionPicker = async () => {
    setShowCollectionPicker(true);
    setLoadingCollections(true);
    try {
      const [allRes, memberRes] = await Promise.all([
        apiFetch('/api/collections'),
        apiFetch(`/api/recipes/${id}/collections`),
      ]);
      const allJson = await allRes.json();
      const memberJson = await memberRes.json();
      setAllCollections((allJson.data || []).map((c: any) => ({ id: c.id, name: c.name })));
      setMemberCollectionIds(new Set((memberJson.data || []).map((c: any) => c.id)));
    } catch (err) {
      console.error('Failed to load collections:', err);
    } finally {
      setLoadingCollections(false);
    }
  };

  const toggleCollectionMembership = async (collectionId: string) => {
    const isMember = memberCollectionIds.has(collectionId);
    setMemberCollectionIds(prev => {
      const next = new Set(prev);
      isMember ? next.delete(collectionId) : next.add(collectionId);
      return next;
    });
    if (isMember) {
      await apiFetch(`/api/collections/${collectionId}/recipes/${id}`, { method: 'DELETE' });
    } else {
      await apiFetch(`/api/collections/${collectionId}/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId: id }),
      });
    }
  };

  /* ── Fetch techniques (needed in every mode to resolve {{tech:id}} refs in step text) ── */
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`/api/techniques${contentLang ? `?lang=${contentLang}` : ''}`);
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
            apiFetch(`/api/tools${contentLang ? `?lang=${contentLang}` : ''}`),
            apiFetch(`/api/units${contentLang ? `?lang=${contentLang}` : ''}`),
            apiFetch(`/api/ingredients${contentLang ? `?lang=${contentLang}` : ''}`),
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
      const res = await apiFetch(`/api/recipes/${id}${contentLang ? `?lang=${contentLang}` : ''}`);
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

  /* ── Kitchen Mode: fetch the sub-recipes-first step sequence, but only
     when this recipe actually has a sub-recipe ingredient — keeps the
     common case (no Matrioska nesting) to a single request. ── */
  useEffect(() => {
    if (mode !== 'cook' || !id || !recipe) { setCookSequence(null); return; }
    const hasSubRecipe = (recipe.ingredients || []).some(ing => !!ing.subRecipeId);
    if (!hasSubRecipe) { setCookSequence(null); return; }
    (async () => {
      try {
        const res = await apiFetch(`/api/recipes/${id}/cook-sequence`);
        const json = await res.json();
        setCookSequence(json.data?.sections || null);
      } catch (err) {
        console.error('Cook sequence fetch failed:', err);
        setCookSequence(null);
      }
    })();
  }, [mode, id, recipe]);

  /* ── Nutrition: fetched once at the recipe's base servings, then scaled
     client-side against the servings slider (same pattern as scale()) so
     moving the slider doesn't trigger a refetch. ── */
  useEffect(() => {
    if (!id || !recipe) { setNutrition(null); return; }
    (async () => {
      try {
        const res = await apiFetch(`/api/recipes/${id}/nutrition?servings=${recipe.servings}`);
        const json = await res.json();
        setNutrition(json.data || null);
      } catch (err) {
        console.error('Nutrition fetch failed:', err);
        setNutrition(null);
      }
    })();
  }, [id, recipe?.id, recipe?.servings]);

  /* ── Scale quantity ─────────────────────────────────────────────── */
  const scale = (qty: number | null): string => {
    if (qty === null) return '';
    if (!recipe) return String(qty);
    const v = (qty * servings) / recipe.servings;
    return v % 1 === 0 ? String(v) : v.toFixed(1);
  };

  /* ── Scale nutrition totals (fetched once at base servings) against the current servings slider ── */
  const nutritionAtServings = (): NutritionTotals | null => {
    if (!nutrition || !recipe) return null;
    const ratio = servings / recipe.servings;
    const t = nutrition.totals;
    return {
      caloriesKcal: t.caloriesKcal * ratio, proteinG: t.proteinG * ratio, carbsG: t.carbsG * ratio,
      fatG: t.fatG * ratio, fiberG: t.fiberG * ratio, sugarG: t.sugarG * ratio, sodiumMg: t.sodiumMg * ratio,
    };
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
      if (ref.amountMode === 'absolute') {
        return {
          name: ing.ingredientName || ing.subRecipeTitle || 'Ingredient',
          quantity: ref.quantity != null ? scale(ref.quantity) : '',
          unitSymbol: ref.unitSymbol || '',
          portionPct: 100,
        };
      }
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
  const toggleStep = (key: string) => {
    setCompletedSteps(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
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
        rating: draft.rating === undefined ? recipe?.rating ?? null : draft.rating,
        tags: draft.tags || [],
        coverImageUrl: draft.cover_image_url || null,
        sourceUrl: draft.source_url || null,
        sources: draft.sources || [],
        isComponent: draft.is_component || false,
        languageCode: draft.language_code || recipe?.language_code || undefined,
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
          translations: ing.translations || [],
        })),
        steps: (draft.steps || []).map((s, i) => ({
          stepNumber: i + 1,
          title: s.title || undefined,
          description: s.description,
          durationMin: s.durationMin || undefined,
          toolIds: s.toolIds || [],
          notes: s.notes || undefined,
          imageUrl: s.imageUrl || null,
          stepIngredients: s.stepIngredients || [],
          translations: s.translations || [],
        })),
        toolIds: (draft.tools || []).map(t => t.id),
      };

      await apiFetch(`/api/recipes/${id}`, {
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

  /* ── Rate recipe ────────────────────────────────────────────────── */
  const handleRate = async (rating: number | null) => {
    if (!id || !recipe) return;
    setRecipe({ ...recipe, rating });
    try {
      await apiFetch(`/api/recipes/${id}/rating`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
    } catch (err) {
      console.error('Rating failed:', err);
    }
  };

  /* ── Log a cook ─────────────────────────────────────────────────── */
  const handleLogCooked = async () => {
    if (!id || !recipe) return;
    const previous = recipe.times_cooked;
    setRecipe({ ...recipe, times_cooked: previous + 1 });
    try {
      const res = await apiFetch(`/api/recipes/${id}/cooked`, { method: 'POST' });
      const json = await res.json();
      setRecipe(r => r ? { ...r, times_cooked: json.data.timesCooked } : r);
    } catch (err) {
      console.error('Logging cooked failed:', err);
      setRecipe(r => r ? { ...r, times_cooked: previous } : r);
    }
  };

  /* ── Delete recipe ──────────────────────────────────────────────── */
  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm(t('recipeDetail.deleteConfirm', { title: recipe?.translated_title || recipe?.title }))) return;
    setSaving(true);
    try {
      await apiFetch(`/api/recipes/${id}`, { method: 'DELETE' });
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
          <p className="text-sm text-zinc-400 font-medium">{t('recipeDetail.loadingRecipe')}</p>
        </div>
      </div>
    );
  }
  if (!recipe) {
    return (
      <div className="min-h-screen bg-[#fafaf5] flex items-center justify-center">
        <div className="text-center">
          <span className="material-symbols-outlined text-6xl text-zinc-300 mb-4 block">error</span>
          <p className="text-zinc-500 font-medium">{t('recipeDetail.recipeNotFound')}</p>
          <Link to="/" className="text-primary font-bold text-sm mt-4 inline-block hover:underline">← {t('recipeDetail.backToGallery')}</Link>
        </div>
      </div>
    );
  }

  const totalTime = (recipe.prep_time_min || 0) + (recipe.cook_time_min || 0) + (recipe.rest_time_min || 0);

  /* ═════════════════════════════════════════════════════════════════
     COOKING MODE
     ═════════════════════════════════════════════════════════════════ */
  if (mode === 'cook' && cookSequence && cookSequence.length > 1) {
    // Recipe has sub-recipe ingredients (Matrioska): flatten into one
    // continuous step list, sub-recipes first, main recipe last, with a
    // section header whenever the source recipe changes.
    type FlatCookStep = { key: string; section: CookSequenceSection; step: CookSequenceStep; isFirstOfSection: boolean };
    const flatSteps: FlatCookStep[] = [];
    for (const section of cookSequence) {
      const sorted = [...section.steps].sort((a, b) => a.stepNumber - b.stepNumber);
      sorted.forEach((step, i) => flatSteps.push({ key: `${section.recipeId}:${step.stepNumber}`, section, step, isFirstOfSection: i === 0 }));
    }
    const progress = flatSteps.length > 0 ? (completedSteps.size / flatSteps.length) * 100 : 0;

    return (
      <div className="min-h-screen bg-zinc-900 text-white font-body">
        <header className="sticky top-0 z-50 bg-zinc-900/95 backdrop-blur-md border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
          <button onClick={() => setMode('view')} className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
            <span className="material-symbols-outlined">arrow_back</span>
            <span className="text-sm font-bold">{t('recipeDetail.exitKitchen')}</span>
          </button>
          <h2 className="text-lg font-headline font-bold text-white truncate max-w-md">{recipe.translated_title || recipe.title}</h2>
          <div className="text-sm text-zinc-400 font-medium">{t('recipeDetail.stepsProgress', { done: completedSteps.size, total: flatSteps.length })}</div>
        </header>

        <div className="h-1 bg-zinc-800">
          <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>

        <main className="max-w-3xl mx-auto px-6 py-10 space-y-8">
          {flatSteps.map(({ key, section, step, isFirstOfSection }) => {
            const done = completedSteps.has(key);
            const sectionIngredients = section.ingredients.map(ing => ({
              sortOrder: ing.sortOrder,
              name: ing.ingredientName,
              quantity: ing.quantity != null ? `${ing.quantity}${ing.unitSymbol ? ' ' + ing.unitSymbol : ''}` : '',
            }));
            const sectionTools = section.tools.map(t => ({ id: t.id, name: t.name }));
            return (
              <React.Fragment key={key}>
                {isFirstOfSection && (
                  <div className="flex items-center gap-3 pt-2 first:pt-0">
                    <span className={`px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider ${section.isMain ? 'bg-primary text-white' : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'}`}>
                      {section.isMain ? t('recipeDetail.mainRecipe') : t('recipeDetail.subRecipe')}
                    </span>
                    <h3 className="text-lg font-headline font-bold text-white truncate">{section.recipeTitle}</h3>
                  </div>
                )}
                <div
                  className={`p-8 rounded-3xl border transition-all duration-300 ${
                    done ? 'bg-primary/10 border-primary/30 opacity-60' : 'bg-zinc-800/50 border-zinc-700/50 hover:border-zinc-600'
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
                        {step.title || t('recipeDetail.stepNumber', { number: step.stepNumber })}
                      </h3>
                      {step.imageUrl && (
                        <img src={step.imageUrl} alt="" className="w-full max-h-64 object-cover rounded-2xl mb-4" />
                      )}
                      <p className="text-zinc-300 leading-relaxed text-[15px] mb-4">
                        <RenderStepText text={step.description} ingredients={sectionIngredients} tools={sectionTools} techniques={stepTextTechniques} />
                      </p>

                      {step.toolIds.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-4">
                          {step.toolIds.map(tid => {
                            const tool = section.tools.find(t => t.id === tid);
                            if (!tool) return null;
                            return (
                              <div key={tid} className="flex items-center gap-1.5 px-2 py-1 bg-zinc-700/50 rounded-lg border border-zinc-600/30">
                                <RenderFaIcon name={tool.icon || 'FaKitchenSet'} className="text-primary text-sm" />
                                <span className="text-[10px] uppercase font-bold text-zinc-400">{tool.name}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {step.durationMin && (
                        <div className="flex items-center gap-2 text-sm text-zinc-400 mb-4">
                          <span className="material-symbols-outlined text-sm">timer</span>
                          {t('recipeDetail.durationMinutes', { count: step.durationMin })}
                        </div>
                      )}

                      {step.notes && (
                        <div className="bg-primary/10 border border-primary/20 rounded-2xl p-4 mb-6">
                          <div className="flex items-center gap-2 text-primary mb-1">
                            <span className="material-symbols-outlined text-sm text-[18px]">lightbulb</span>
                            <span className="text-[10px] uppercase font-bold tracking-wider">{t('recipeDetail.chefsNote')}</span>
                          </div>
                          <p className="text-sm text-zinc-300 italic">{step.notes}</p>
                        </div>
                      )}

                      <button
                        onClick={() => toggleStep(key)}
                        className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-sm transition-all ${
                          done ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600' : 'bg-primary text-white hover:bg-primary/80'
                        }`}
                      >
                        <span className="material-symbols-outlined text-sm">{done ? 'undo' : 'check_circle'}</span>
                        {done ? t('recipeDetail.undo') : t('recipeDetail.markAsComplete')}
                      </button>
                    </div>
                  </div>
                </div>
              </React.Fragment>
            );
          })}

          {progress === 100 && (
            <div className="text-center py-12 animate-fade-in-up">
              <span className="text-6xl mb-4 block">🎉</span>
              <h2 className="font-headline font-extrabold text-3xl text-primary mb-2">{t('recipeDetail.bonAppetit')}</h2>
              <p className="text-zinc-400">{t('recipeDetail.allStepsCompleted')}</p>
              <button onClick={() => setMode('view')} className="mt-6 px-8 py-3 bg-primary text-white rounded-full font-bold hover:bg-primary/80 transition-colors">
                {t('recipeDetail.backToRecipe')}
              </button>
            </div>
          )}
        </main>
      </div>
    );
  }

  if (mode === 'cook') {
    const sortedSteps = [...(recipe.steps || [])].sort((a, b) => a.stepNumber - b.stepNumber);
    const progress = recipe.steps.length > 0 ? (completedSteps.size / recipe.steps.length) * 100 : 0;

    return (
      <div className="min-h-screen bg-zinc-900 text-white font-body">
        {/* Header */}
        <header className="sticky top-0 z-50 bg-zinc-900/95 backdrop-blur-md border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
          <button onClick={() => setMode('view')} className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
            <span className="material-symbols-outlined">arrow_back</span>
            <span className="text-sm font-bold">{t('recipeDetail.exitKitchen')}</span>
          </button>
          <h2 className="text-lg font-headline font-bold text-white truncate max-w-md">{recipe.translated_title || recipe.title}</h2>
          <div className="text-sm text-zinc-400 font-medium">{t('recipeDetail.stepsProgress', { done: completedSteps.size, total: recipe.steps.length })}</div>
        </header>

        {/* Progress bar */}
        <div className="h-1 bg-zinc-800">
          <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>

        {/* Steps */}
        <main className="max-w-3xl mx-auto px-6 py-10 space-y-8">
          {sortedSteps.map((step) => {
            const stepKey = `${recipe.id}:${step.stepNumber}`;
            const done = completedSteps.has(stepKey);
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
                      {step.translatedTitle || step.title || t('recipeDetail.stepNumber', { number: step.stepNumber })}
                    </h3>
                    {step.imageUrl && (
                      <img src={step.imageUrl} alt="" className="w-full max-h-64 object-cover rounded-2xl mb-4" />
                    )}
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
                        {t('recipeDetail.durationMinutes', { count: step.durationMin })}
                      </div>
                    )}

                    {/* Step Note */}
                    {(step.translatedNotes || step.notes) && (
                      <div className="bg-primary/10 border border-primary/20 rounded-2xl p-4 mb-6">
                        <div className="flex items-center gap-2 text-primary mb-1">
                          <span className="material-symbols-outlined text-sm text-[18px]">lightbulb</span>
                          <span className="text-[10px] uppercase font-bold tracking-wider">{t('recipeDetail.chefsNote')}</span>
                        </div>
                        <p className="text-sm text-zinc-300 italic">{step.translatedNotes || step.notes}</p>
                      </div>
                    )}

                    <button
                      onClick={() => toggleStep(stepKey)}
                      className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-sm transition-all ${
                        done
                          ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                          : 'bg-primary text-white hover:bg-primary/80'
                      }`}
                    >
                      <span className="material-symbols-outlined text-sm">{done ? 'undo' : 'check_circle'}</span>
                      {done ? t('recipeDetail.undo') : t('recipeDetail.markAsComplete')}
                    </button>

                  </div>
                </div>
              </div>
            );
          })}

          {progress === 100 && (
            <div className="text-center py-12 animate-fade-in-up">
              <span className="text-6xl mb-4 block">🎉</span>
              <h2 className="font-headline font-extrabold text-3xl text-primary mb-2">{t('recipeDetail.bonAppetit')}</h2>
              <p className="text-zinc-400">{t('recipeDetail.allStepsCompleted')}</p>
              <button onClick={() => setMode('view')} className="mt-6 px-8 py-3 bg-primary text-white rounded-full font-bold hover:bg-primary/80 transition-colors">
                {t('recipeDetail.backToRecipe')}
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
        steps: [...(prev.steps || []), { id: '', stepNumber: (prev.steps?.length || 0) + 1, title: '', description: '', durationMin: null, toolIds: [], notes: '', imageUrl: null, stepIngredients: [], translations: [] }],
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
    // toggleStepIngredient this never removes, used when inserting an
    // inline {{ing:N}} reference from the step text toolbar.
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
        if (exists) {
          return {
            ...prev,
            tools: tools.filter(t => t.id !== tool.id),
            // Deselecting a tool removes it from any step that referenced
            // it, so it can't be silently dropped from recipe_tools on save
            // while a step still shows it as used.
            steps: (prev.steps || []).map(s => ({
              ...s,
              toolIds: (s.toolIds || []).filter(id => id !== tool.id),
            })),
          };
        }
        return { ...prev, tools: [...tools, tool] };
      });

    return (
      <div className="min-h-screen bg-[#fafaf5] font-body">
        {/* Header */}
        <header className="bg-[#fafaf5]/90 backdrop-blur-md sticky top-0 z-50 border-b border-zinc-200/60 px-8 py-4 flex items-center justify-between">
          <button onClick={() => { setDraft(recipe); setMode('view'); }} className="flex items-center gap-2 text-zinc-500 hover:text-zinc-800 transition-colors">
            <span className="material-symbols-outlined">close</span>
            <span className="text-sm font-bold">{t('common.cancel')}</span>
          </button>
          <h2 className="text-lg font-headline font-bold text-zinc-800">{t('recipeDetail.editRecipe')}</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={handleDelete}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-red-500 hover:bg-red-50 rounded-full font-bold text-sm transition-all disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">delete</span>
              {t('common.delete')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2 bg-primary text-white rounded-full font-bold text-sm hover:bg-primary/90 transition-all disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">{saving ? 'sync' : 'save'}</span>
              {saving ? t('recipeDetail.saving') : t('recipeDetail.saveRecipe')}
            </button>
          </div>
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
                    value={draft.language_code || recipe.language_code || 'en'}
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
              <label>
                <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">{t('recipeDetail.yourRating')}</span>
                <StarRating value={draft.rating} onChange={rating => updateDraft('rating', rating)} />
              </label>
              <div className="flex-1 min-w-[200px]">
                <span className="text-xs uppercase tracking-wider text-zinc-400 font-bold mb-2 block">{t('recipeDetail.tags')}</span>
                <TagPicker value={draft.tags || []} onChange={tags => updateDraft('tags', tags)} />
              </div>
            </div>
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
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.ingredient')}</label>
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
                    <div className="col-span-12">
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.chefsNoteOptional')}</label>
                      <input
                        type="text" value={ing.notes || ''}
                        onChange={e => updateIngredient(idx, 'notes', e.target.value)}
                        className="w-full border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                        placeholder={t('recipeDetail.chefsNoteIngredientPlaceholder')}
                      />
                    </div>
                    <div className="col-span-12">
                      <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.ingredientTranslationsOptional')}</label>
                      <TranslationsEditor
                        translations={ing.translations || []}
                        onChange={translations => updateIngredient(idx, 'translations', translations)}
                        showTitleDescription={false}
                        notesLabel={t('recipeDetail.chefsNoteIngredientPlaceholder')}
                        compact
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
                      className="flex-1 border-none bg-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <div className="mt-3">
                    <label className="block text-[10px] uppercase font-bold text-zinc-400 mb-1">{t('recipeDetail.stepTranslationsOptional')}</label>
                    <TranslationsEditor
                      translations={step.translations || []}
                      onChange={translations => updateStep(idx, 'translations', translations)}
                      titleLabel={t('recipeDetail.stepTitle')}
                      descriptionLabel={t('recipeDetail.stepDescription')}
                      notesLabel={t('recipeDetail.chefsNote')}
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
                                {ing.ingredientName || ing.subRecipeTitle || t('recipeDetail.unnamedIngredient')}
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
      aria-label={t('recipeDetail.editRecipeAria')}
    >
      <span className="material-symbols-outlined text-[20px]">edit</span>
    </button>
  );

  const deleteButton = (
    <button
      onClick={handleDelete}
      disabled={saving}
      className="flex items-center gap-1.5 text-zinc-500 hover:text-red-500 transition-colors disabled:opacity-50"
      aria-label={t('recipeDetail.deleteRecipe')}
      title={t('recipeDetail.deleteRecipe')}
    >
      <span className="material-symbols-outlined text-[20px]">delete</span>
    </button>
  );

  const shoppingListHeaderButton = (
    <button
      onClick={() => {
        addToShoppingCart({ recipeId: id!, title: recipe.translated_title || recipe.title, servings });
        setAddedToCart(true);
        setTimeout(() => setAddedToCart(false), 2000);
      }}
      className={`flex items-center gap-1.5 transition-colors ${addedToCart ? 'text-primary' : 'text-zinc-500 hover:text-primary'}`}
      aria-label={t('recipeDetail.addToShoppingList')}
      title={t('recipeDetail.addToShoppingList')}
    >
      <span className="material-symbols-outlined text-[20px]">{addedToCart ? 'check' : 'shopping_cart'}</span>
    </button>
  );

  const handleExportRecipe = async () => {
    try {
      const res = await apiFetch(`/api/share/recipes/${id}/export`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ? JSON.stringify(json.error) : 'Export failed');
      const slug = (recipe.translated_title || recipe.title || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}.smartchef.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Recipe export failed:', err);
    }
  };

  const exportHeaderButton = (
    <button
      onClick={handleExportRecipe}
      className="flex items-center gap-1.5 text-zinc-500 hover:text-primary transition-colors"
      aria-label={t('recipeDetail.exportRecipe')}
      title={t('recipeDetail.exportRecipe')}
    >
      <span className="material-symbols-outlined text-[20px]">ios_share</span>
    </button>
  );

  const collectionHeaderButton = (
    <div className="relative">
      <button
        onClick={() => showCollectionPicker ? setShowCollectionPicker(false) : openCollectionPicker()}
        className={`flex items-center gap-1.5 transition-colors ${memberCollectionIds.size > 0 ? 'text-primary' : 'text-zinc-500 hover:text-primary'}`}
        aria-label={t('recipeDetail.addToCollection')}
        title={t('recipeDetail.addToCollection')}
      >
        <span className="material-symbols-outlined text-[20px]">collections_bookmark</span>
      </button>
      {showCollectionPicker && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowCollectionPicker(false)} />
          <div className="absolute right-0 top-8 z-50 w-64 bg-white rounded-2xl shadow-xl border border-zinc-100 p-3">
            <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest px-2 pb-2">{t('recipeDetail.addToCollection')}</p>
            {loadingCollections ? (
              <p className="text-xs text-zinc-400 px-2 py-2">{t('common.loading')}</p>
            ) : allCollections.length === 0 ? (
              <p className="text-xs text-zinc-400 px-2 py-2">{t('recipeDetail.noCollectionsYetCreateOne')}</p>
            ) : (
              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {allCollections.map(c => (
                  <label key={c.id} className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-zinc-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={memberCollectionIds.has(c.id)}
                      onChange={() => toggleCollectionMembership(c.id)}
                      className="accent-primary w-4 h-4"
                    />
                    <span className="text-sm font-medium text-zinc-700">{c.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  const headerActions = (
    <>
      {shoppingListHeaderButton}
      {collectionHeaderButton}
      {exportHeaderButton}
      {deleteButton}
      {editButton}
    </>
  );

  return (
    <AppLayout headerActions={headerActions}>
      {/* ── Hero Image ─────────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-6 pt-8">
        <div className="relative h-[360px] md:h-[440px] rounded-3xl overflow-hidden">
          <img className="w-full h-full object-cover" src={recipe.cover_image_url || 'https://images.unsplash.com/photo-1495521821757-a1efb6729352?q=80&w=2000'} alt={recipe.translated_title || recipe.title} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          <div className="absolute bottom-8 left-8 right-8">
            {(recipe.tags_display?.[0] || recipe.tags?.[0]) && (
              <span
                className={`inline-block px-3 py-1 text-white text-[10px] font-bold uppercase tracking-[0.15em] rounded-full mb-3 ${recipe.tags_display?.[0]?.color ? '' : 'bg-primary'}`}
                style={recipe.tags_display?.[0]?.color ? { backgroundColor: recipe.tags_display[0].color } : undefined}
              >
                {recipe.tags_display?.[0]?.translated_name || recipe.tags[0]}
              </span>
            )}
            <h1 className="text-4xl md:text-6xl font-headline font-extrabold text-white leading-none">{recipe.translated_title || recipe.title}</h1>
            {recipe.creator_name && (
              <div className="flex items-center gap-2 mt-3">
                <img
                  src={recipe.creator_avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${recipe.creator_name}`}
                  alt={recipe.creator_name}
                  className="w-5 h-5 rounded-full object-cover"
                />
                <p className="text-white/70 text-xs font-medium">by {recipe.creator_name}</p>
              </div>
            )}
            {recipe.language_code && contentLang && recipe.language_code !== contentLang && !recipe.translated_title && (
              <p className="mt-3 text-white/70 text-xs font-medium">
                {t('recipeDetail.shownInOriginal', {
                  shownLang: SUPPORTED_LANGUAGES.find(l => l.code === recipe.language_code)?.label || recipe.language_code,
                  targetLang: SUPPORTED_LANGUAGES.find(l => l.code === contentLang)?.label || contentLang,
                })}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Stats Bar ──────────────────────────────────────────── */}
      <div className="max-w-6xl mx-auto px-6 mt-8">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {[
            { label: t('recipeDetail.prepTime'), val: formatTime(recipe.prep_time_min), icon: 'schedule' },
            { label: t('recipeDetail.waitingTime'), val: formatTime(recipe.rest_time_min), icon: 'hourglass_empty' },
            { label: t('recipeDetail.cookTime'), val: formatTime(recipe.cook_time_min), icon: 'oven_gen' },
            { label: t('recipeDetail.totalTime'), val: formatTime(totalTime), icon: 'local_fire_department' },
            { label: t('recipeDetail.complexity'), val: difficultyKey[recipe.difficulty] ? t(difficultyKey[recipe.difficulty]) : recipe.difficulty, icon: 'restaurant', highlight: true },
          ].map((stat, i) => (
            <div key={i} className={`py-5 px-4 rounded-2xl flex flex-col items-center text-center ${stat.highlight ? 'bg-primary/8 border border-primary/15' : 'bg-white border border-zinc-100'}`}>
              <span className={`material-symbols-outlined mb-1.5 ${stat.highlight ? 'text-primary' : 'text-primary/60'}`} style={{ fontVariationSettings: "'FILL' 1" }}>{stat.icon}</span>
              <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 font-bold">{stat.label}</p>
              <p className={`text-lg font-bold font-headline ${stat.highlight ? 'text-primary' : 'text-zinc-800'}`}>{stat.val}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 py-4 px-6 rounded-2xl bg-white border border-zinc-100 flex items-center justify-between flex-wrap gap-3">
          <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 font-bold">{t('recipeDetail.yourRating')}</p>
          <StarRating value={recipe.rating} onChange={handleRate} />
        </div>
        <div className="mt-3 py-4 px-6 rounded-2xl bg-white border border-zinc-100 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary/60" style={{ fontVariationSettings: "'FILL' 1" }}>skillet</span>
            <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 font-bold">
              {t('recipeDetail.cookedTimes', { count: recipe.times_cooked })}
            </p>
          </div>
          <button
            onClick={handleLogCooked}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary/8 text-primary text-xs font-bold hover:bg-primary/15 transition-colors"
          >
            <span className="material-symbols-outlined text-base">add</span>
            {t('recipeDetail.iCookedThis')}
          </button>
        </div>
        <div className="mt-3 px-6 flex items-center gap-4 text-[11px] text-zinc-400 font-medium">
          <span>{t('recipeDetail.created', { date: formatDate(recipe.created_at) })}</span>
          <span>&middot;</span>
          <span>{t('recipeDetail.lastEdited', { date: formatDate(recipe.updated_at) })}</span>
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
                <h3 className="font-headline font-bold text-lg">{t('recipeDetail.servings')}</h3>
                <span className="text-3xl font-extrabold text-primary font-headline">{servings}</span>
              </div>
              <input
                type="range" min="1" max="12"
                value={servings}
                onChange={(e) => setServings(parseInt(e.target.value))}
                className="w-full h-2 bg-zinc-100 rounded-full appearance-none cursor-pointer accent-primary"
              />
              <div className="flex justify-between mt-2 text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                <span>{t('recipeDetail.onePortion')}</span><span>{t('recipeDetail.twelvePortions')}</span>
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
                {addedToCart ? t('recipeDetail.addedToShoppingList') : t('recipeDetail.addToShoppingList')}
              </button>
            </div>

            {/* Ingredients card */}
            <div className="bg-white rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100">
              <h3 className="font-headline font-bold text-lg mb-5">{t('recipeDetail.ingredients')}</h3>
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
                    {(ing.translatedNotes || ing.notes) && (
                      <p className="px-3 pb-2 text-[11px] text-zinc-400 font-medium italic">— {ing.translatedNotes || ing.notes}</p>
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
                <h3 className="font-headline font-bold text-lg mb-5">{t('recipeDetail.kitchenTools')}</h3>
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

            {/* References card */}
            {recipe.sources && recipe.sources.length > 0 && (
              <div className="bg-white rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100">
                <h3 className="font-headline font-bold text-lg mb-5">{t('recipeDetail.references')}</h3>
                <div className="space-y-2">
                  {recipe.sources.map((s, idx) => {
                    const meta = SOURCE_TYPE_META[s.type] || SOURCE_TYPE_META.other;
                    const content = (
                      <div className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-zinc-50 transition-colors">
                        <span className="material-symbols-outlined text-primary text-lg shrink-0">{meta.icon}</span>
                        <span className="text-sm font-semibold text-zinc-700 truncate">{s.label || s.url}</span>
                      </div>
                    );
                    return s.url ? (
                      <a key={idx} href={s.url} target="_blank" rel="noopener noreferrer">{content}</a>
                    ) : (
                      <div key={idx}>{content}</div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Nutrition card */}
            {nutrition && (nutrition.totals.caloriesKcal > 0 || nutrition.totals.proteinG > 0 || nutrition.totals.carbsG > 0 || nutrition.totals.fatG > 0) && (() => {
              const at = nutritionAtServings()!;
              const fields: { key: keyof NutritionTotals; label: string; unit: string }[] = [
                { key: 'caloriesKcal', label: t('recipeDetail.calories'), unit: 'kcal' },
                { key: 'proteinG', label: t('recipeDetail.protein'), unit: 'g' },
                { key: 'carbsG', label: t('recipeDetail.carbs'), unit: 'g' },
                { key: 'fatG', label: t('recipeDetail.fat'), unit: 'g' },
                { key: 'fiberG', label: t('recipeDetail.fiber'), unit: 'g' },
                { key: 'sugarG', label: t('recipeDetail.sugar'), unit: 'g' },
                { key: 'sodiumMg', label: t('recipeDetail.sodium'), unit: 'mg' },
              ];
              return (
                <div className="bg-white rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100">
                  <h3 className="font-headline font-bold text-lg mb-1">{t('recipeDetail.nutrition')}</h3>
                  <p className="text-[11px] text-zinc-400 mb-4">{t('recipeDetail.totalForServings', { count: servings })}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {fields.map(f => (
                      <div key={f.key} className="flex items-center justify-between px-3 py-2 rounded-xl bg-zinc-50">
                        <span className="text-xs font-semibold text-zinc-500">{f.label}</span>
                        <span className="text-sm font-bold text-zinc-800 tabular-nums">
                          {Math.round(at[f.key])} {f.unit}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-zinc-400 mt-3">
                    {t('recipeDetail.kcalPerServing', { count: Math.round(at.caloriesKcal / servings) })}
                  </p>
                  {nutrition.unresolved.length > 0 && (
                    <p className="text-[10px] text-amber-600 mt-3 italic">
                      {t('recipeDetail.nutritionUnavailableFor', { items: nutrition.unresolved.join(', ') })}
                    </p>
                  )}
                </div>
              );
            })()}
          </div>


          {/* Right column: Method + Kitchen Mode button */}
          <div className="lg:col-span-8">
            <div className="flex items-center justify-between mb-8">
              <h2 className="font-headline font-extrabold text-3xl text-zinc-900">{t('recipeDetail.theMethod')}</h2>
              <button
                onClick={() => { setCompletedSteps(new Set()); setMode('cook'); }}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-full font-bold text-sm shadow-sm hover:bg-primary/90 transition-all active:scale-95"
              >
                <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>skillet</span>
                {t('recipeDetail.kitchenMode')}
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
                      {step.translatedTitle || step.title || t('recipeDetail.stepNumber', { number: step.stepNumber })}
                    </h4>
                    <div className="bg-white p-6 rounded-2xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 group-hover:border-primary/15 transition-colors">
                      {step.imageUrl && (
                        <img src={step.imageUrl} alt="" className="w-full max-h-64 object-cover rounded-xl mb-4" />
                      )}
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
                          {t('recipeDetail.durationMinutes', { count: step.durationMin })}
                        </div>
                      )}
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