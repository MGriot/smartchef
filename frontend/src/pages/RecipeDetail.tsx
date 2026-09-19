import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { useStore } from '../store/app.store';
import { listLanguages, languageLabel } from '../lib/languages';
import { useLanguages } from '../hooks/useLanguages';
import { canPrint, printPage } from '../lib/print';
import RenderFaIcon from '../components/RenderFaIcon';
import Autocomplete from '../components/Autocomplete';
import StepEditor, { StepIngredientAmount } from '../components/StepEditor';
import RecipeSourcesEditor, { RecipeSourceEntry, SOURCE_TYPE_META } from '../components/RecipeSourcesEditor';
import ImageUrlInput from '../components/ImageUrlInput';
import TranslationsEditor, { TranslationEntry } from '../components/TranslationsEditor';
import TagPicker from '../components/TagPicker';
import { pickIngredientName } from '../lib/ingredientDisplay';
import { coerceIngredients, coerceSteps, coerceNamedEntities } from '../lib/recipeDraftCoercion';
import RegionPicker from '../components/RegionPicker';
import RegionsMap from '../components/RegionsMap';
import RenderStepText from '../components/RenderStepText';
import AutoTextarea from '../components/AutoTextarea';
import {
  STEP_REF_RE, syncIngredientRefAmount, reindexIngredientRefs,
  stepIngredientConsumption, remainingBeforeStep,
} from '../lib/stepRefs';
import CookTimerBar from '../components/CookTimerBar';
import FloatingActionBar, { FLOATING_ACTION_BAR_CLEARANCE } from '../components/FloatingActionBar';
import { useWakeLock } from '../hooks/useWakeLock';
import { startCookTimer, requestTimerNotifications } from '../lib/cookTimers';
import { toSystem, type MeasurementSystem } from '../lib/unitConvert';
import ConverterPanel from '../components/ConverterPanel';
import ShareLinkModal from '../components/ShareLinkModal';
import AppLayout from '../components/AppLayout';
import StarRating from '../components/StarRating';
import CoverImage, { ResolvedImage } from '../components/CoverImage';
import { apiFetch, isNative } from '../lib/api';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { countryDisplayName, flagEmoji, isCountryCode } from '../lib/countries';
import { buildCookidooExport, type CookidooExport } from '../lib/cookidooExport';

/* ═══════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════ */
interface Ingredient {
  id: string;
  sortOrder: number;
  ingredientId: string | null;
  ingredientName: string;
  ingredientPluralName?: string | null;
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
  /** Optional "Per il condimento"/"Per l'impasto" style group header — see
   *  RecipeIngredientInput.groupName in recipes.local.ts. */
  groupName?: string | null;
  /** sortOrder of the ingredient this row stands in for — "or margarine,
   *  instead of the butter". See db/migrations/042_recipe_ingredient_substitutes.sql. */
  substituteFor?: number | null;
}

/** A row of the ingredient library as the editor needs it: the name to
 *  show, plus every other way this ingredient can be named, which is what
 *  an inline step reference gets to use as its label. */
interface LibraryIngredient {
  id: string;
  name: string;
  translated_name?: string | null;
  plural_name?: string | null;
  synonyms?: string[];
  translations?: Array<{ lang: string; text: string }>;
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
  techniqueIds: string[];
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
  /** Alternate names — offered as the label for an inline {{tool:id}}
   *  reference so a step can say "la padella" without losing the link. */
  synonyms?: string[];
}

interface Technique {
  id: string;
  name: string;
  icon: string | null;
  translated_name?: string | null;
}

interface Recipe {
  id: string;
  title: string;
  translated_title?: string | null;
  description: string | null;
  translated_description?: string | null;
  /** How to store leftovers ("Come conservare"). */
  storage_instructions: string | null;
  /** General tips/notes distinct from description ("Consigli"). */
  tips: string | null;
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
  regions: string[];
  region_coords: Record<string, { lat: number; lng: number }>;
  yield_amount: number | null;
  yield_unit_id: string | null;
  cover_image_url: string;
  source_url: string | null;
  sources: RecipeSourceEntry[];
  is_component: boolean;
  language_code?: string | null;
  translations: TranslationEntry[];
  ingredients: Ingredient[];
  steps: Step[];
  tools: Tool[];
  techniques: Technique[];
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
  techniqueIds: string[];
  imageUrl: string | null;
  notes: string | null;
  /** What this step takes out of the section's ingredients — see
   *  matrioska.local.ts. Optional because a recipe saved before this was
   *  carried through the cook sequence simply has none. */
  stepIngredients?: StepIngredientRef[];
}
interface CookSequenceIngredientRef {
  sortOrder: number;
  ingredientName: string;
  quantity: number | null;
  unitSymbol: string | null;
  groupName: string | null;
}
interface CookSequenceToolRef {
  id: string;
  name: string;
  icon: string | null;
}
interface CookSequenceTechniqueRef {
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
  techniques: CookSequenceTechniqueRef[];
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
// Recipe actions inside FloatingActionBar: 44px touch targets instead of the
// header's bare 20px icons.
const BAR_BUTTON = 'w-11 h-11 justify-center rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800';
// A header popover hangs down from its icon; one opened from the floating bar
// has to open upward and span the screen instead, or a 256px menu anchored to
// an icon near the middle of a 390px screen runs off the left edge.
const popoverPlacement = (inBar: boolean) =>
  inBar ? 'fixed left-4 right-4 mx-auto max-w-sm z-50' : 'absolute right-0 top-8 z-50 w-64';
const POPOVER_ABOVE_BAR: React.CSSProperties = { bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' };

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

/** De-duplicates and tidies a pile of candidate names, case-insensitively
 *  and keeping the first spelling of each. Used to build the "show as"
 *  suggestions for inline step references out of whatever the catalog row
 *  happens to carry — its name, its plural, its synonyms, its
 *  translations. */
/** How an amount is written INTO a step's text and into the editor's own
 *  summaries — plain and unscaled, because the editor works in the
 *  recipe's own base servings. (View mode's formatAmount() is the one that
 *  scales to the slider and restates in the reader's measurement system.) */
const formatEditorAmount = (qty: number, unitSymbol?: string | null): string =>
  `${qty % 1 === 0 ? qty : Number(qty.toFixed(2))}${unitSymbol ? ` ${unitSymbol}` : ''}`;

const uniqueNames = (values: Array<string | null | undefined>): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = (value ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
};

/** The opening of a step's text, for the one-line summary a folded step
 *  card shows when it has no title of its own. Inline reference tokens are
 *  stripped rather than expanded: this is a label, not the sentence. */
const firstWordsOf = (text: string | null | undefined, max = 60): string => {
  const plain = (text ?? '').replace(STEP_REF_RE, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  return plain.slice(0, max).replace(/\s\S*$/, '') + '…';
};

/** An ingredient note as imports leave it — ", 7 circa," — without the
 *  separators that belonged to the source line around it. */
const tidyNote = (note: string | null | undefined): string =>
  (note ?? '').replace(/^[\s,;]+|[\s,;]+$/g, '');

const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' });
};

/* ── Sub-recipe ingredient fetcher ─────────────────────────────────── */
const SubIngredientList: React.FC<{
  subRecipeId: string; servings: number; baseServings: number;
}> = ({ subRecipeId, servings, baseServings }) => {
  const { t } = useTranslation();
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

  if (loading) return <div className="pl-6 py-2 text-xs text-zinc-400 dark:text-zinc-500 animate-pulse">{t('common.loading')}</div>;
  if (!ingredients.length) return null;

  return (
    <div className="ml-4 mt-1 mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider hover:text-primary transition-colors mb-1"
      >
        <span className="material-symbols-outlined text-sm">{open ? 'expand_less' : 'expand_more'}</span>
        {ingredients.length} sub-ingredients
      </button>
      {open && (
        <div className="space-y-1 pl-2 border-l-2 border-primary/10">
          {ingredients.map((ing, i) => {
            const scaled = ing.quantity ? ((ing.quantity * servings) / baseServings) : null;
            return (
              <div key={i} className="flex justify-between text-sm text-zinc-500 dark:text-zinc-400 py-1">
                <span>{ing.ingredientName ? pickIngredientName(ing.ingredientName, ing.ingredientPluralName, scaled) : ing.subRecipeTitle}</span>
                <span className="text-zinc-400 dark:text-zinc-500 font-medium">
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
  const { languages } = useLanguages();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const mode: PageMode = (searchParams.get('mode') as PageMode) || 'view';
  const setMode = (m: PageMode) => setSearchParams({ mode: m });

  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [servings, setServings] = useState(4);

  // Display only — the recipe still stores exactly what its author wrote.
  // Remembered per device because it is a preference about the reader, not
  // a property of the recipe.
  const [displaySystem, setDisplaySystem] = useState<MeasurementSystem>(() => {
    try {
      return (localStorage.getItem('smartchef.displaySystem') as MeasurementSystem) || 'metric';
    } catch {
      return 'metric';
    }
  });
  useEffect(() => {
    try { localStorage.setItem('smartchef.displaySystem', displaySystem); } catch { /* ignore */ }
  }, [displaySystem]);
  const [showConverter, setShowConverter] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  // Kitchen mode's per-ingredient ticks, keyed `<recipeId>:<stepNumber>#<ingredient sortOrder>`.
  // Same reasoning as completedSteps below: where you are in tonight's
  // cook is this device's business and must survive stepping out to the
  // shopping list and back.
  const [checkedIngredients, setCheckedIngredients] = useState<Set<string>>(new Set());

  // Kitchen mode is read hands-free across a whole cook, so the screen must
  // not dim. Only requested while actually in cook mode — holding a wake
  // lock on the ordinary recipe page would be rude.
  const wakeLockState = useWakeLock(mode === 'cook');

  // Ticking a step off used to be component state that reset on every
  // entry, so stepping out to the shopping list and back lost the lot.
  // Per-recipe, and deliberately localStorage rather than the database:
  // "where I am in tonight's cook" is this device's business and should not
  // sync to anyone else's phone.
  useEffect(() => {
    if (mode !== 'cook' || !id) return;
    try {
      const saved = localStorage.getItem(`smartchef.cookProgress.${id}`);
      if (saved) setCompletedSteps(new Set(JSON.parse(saved) as string[]));
      const savedIngredients = localStorage.getItem(`smartchef.cookIngredients.${id}`);
      if (savedIngredients) setCheckedIngredients(new Set(JSON.parse(savedIngredients) as string[]));
    } catch {
      /* private mode, cleared storage — start from zero */
    }
  }, [mode, id]);

  useEffect(() => {
    if (mode !== 'cook' || !id) return;
    try {
      localStorage.setItem(`smartchef.cookProgress.${id}`, JSON.stringify([...completedSteps]));
      localStorage.setItem(`smartchef.cookIngredients.${id}`, JSON.stringify([...checkedIngredients]));
    } catch {
      /* nothing worth failing a cook over */
    }
  }, [mode, id, completedSteps, checkedIngredients]);
  const [addedToCart, setAddedToCart] = useState(false);
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showShareLink, setShowShareLink] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  useEffect(() => {
    import('../lib/standalone').then(({ isStandaloneMode }) => isStandaloneMode()).then(setIsStandalone);
  }, []);
  const [cookidooExport, setCookidooExport] = useState<CookidooExport | null>(null);
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [allCollections, setAllCollections] = useState<{ id: string; name: string }[]>([]);
  const [memberCollectionIds, setMemberCollectionIds] = useState<Set<string>>(new Set());
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [cookSequence, setCookSequence] = useState<CookSequenceSection[] | null>(null);
  const [nutrition, setNutrition] = useState<RecipeNutritionResult | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Edit-mode draft state
  const [draft, setDraft] = useState<Partial<Recipe>>({});
  // Raw-text edit: a straight JSON view of `draft` for fast copy/paste
  // editing, alternative to the GUI form below — same `draft` state and
  // `handleSave`, just a different way of producing edits into it.
  const [rawTextMode, setRawTextMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawTextError, setRawTextError] = useState<string | null>(null);
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [allUnits, setAllUnits] = useState<{ id: string; name: string; symbol: string; translated_name?: string | null }[]>([]);
  const [allIngredients, setAllIngredients] = useState<LibraryIngredient[]>([]);
  const [allTechniques, setAllTechniques] = useState<{ id: string; name: string; icon: string | null; translated_name?: string | null; synonyms?: string[] }[]>([]);
  const [allRecipes, setAllRecipes] = useState<{ id: string; title: string; translated_title?: string | null }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; translated_name?: string | null }[]>([]);
  const [ingredientEntryTypes, setIngredientEntryTypes] = useState<Record<number, 'ingredient' | 'recipe'>>({});
  // Which ingredient/step cards are folded down to a one-line summary, and
  // whether the two editors are folded whole. A long recipe is ~20 cards of
  // eight fields each, so "I've finished with this one" needs somewhere to
  // go — otherwise every later edit is a scroll past everything already
  // done. Deliberately component state, not persisted: it describes this
  // editing session, not the recipe.
  const [collapsedIngredients, setCollapsedIngredients] = useState<Set<number>>(new Set());
  const [collapsedSteps, setCollapsedSteps] = useState<Set<number>>(new Set());
  const [ingredientsFolded, setIngredientsFolded] = useState(false);
  const [stepsFolded, setStepsFolded] = useState(false);
  // Inline "create new ingredient/tool/technique" without leaving the
  // editor — see RecipeCreate.tsx's identical pattern.
  const [pendingIngredient, setPendingIngredient] = useState<{ idx: number; name: string; categoryId: string; pluralName: string; description: string } | null>(null);
  const [creatingPendingIngredient, setCreatingPendingIngredient] = useState(false);
  const [newToolName, setNewToolName] = useState('');
  const [newTechniqueName, setNewTechniqueName] = useState('');
  const { t, i18n } = useTranslation();
  const isOnline = useOnlineStatus();
  const contentLang = useStore((s) => s.contentLang);
  const addToShoppingCart = useStore((s) => s.addToShoppingCart);

  // The language this page is read in. Starts at the app's content language;
  // the picker in the hero switches it for this recipe only — the app-wide
  // setting stays where it is.
  const [viewLang, setViewLang] = useState<string | null>(null);
  useEffect(() => { setViewLang(null); }, [id]);
  const shownLang = viewLang ?? contentLang;

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

  // In view mode, library suggestion names (ingredients/tools/techniques)
  // should track the app's UI language (contentLang) — that's the language
  // the reader is browsing in. In edit mode they should instead track the
  // language the recipe ITSELF is being written in (draft.language_code,
  // falling back to the loaded recipe's own language, then contentLang) —
  // otherwise editing a recipe written in Italian while the app's own UI
  // language is English left every ingredient/tool/technique suggestion
  // showing its English translated_name, since these fetches used to key
  // off contentLang unconditionally regardless of mode.
  const libraryLang = mode === 'edit' ? (draft.language_code || recipe?.language_code || contentLang) : contentLang;

  /* ── Fetch techniques (needed in every mode to resolve {{tech:id}} refs in step text) ── */
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`/api/techniques${libraryLang ? `?lang=${libraryLang}` : ''}`);
        const json = await res.json();
        setAllTechniques(json.data || []);
      } catch (err) { console.error('Techniques fetch failed:', err); }
    })();
  }, [libraryLang]);

  /* ── Fetch library data (for edit mode) ────────────────────────── */
  useEffect(() => {
    if (mode === 'edit') {
      (async () => {
        try {
          const [tRes, uRes, iRes, rRes, catRes] = await Promise.all([
            apiFetch(`/api/tools${libraryLang ? `?lang=${libraryLang}` : ''}`),
            apiFetch(`/api/units${libraryLang ? `?lang=${libraryLang}` : ''}`),
            apiFetch(`/api/ingredients${libraryLang ? `?lang=${libraryLang}` : ''}`),
            apiFetch(`/api/recipes${libraryLang ? `?lang=${libraryLang}` : ''}`),
            apiFetch(`/api/ingredients/categories${libraryLang ? `?lang=${libraryLang}` : ''}`),
          ]);
          const [tJson, uJson, iJson, rJson, catJson] = await Promise.all([tRes.json(), uRes.json(), iRes.json(), rRes.json(), catRes.json()]);
          setAllTools(tJson.data || []);
          setAllUnits(uJson.data || []);
          setAllIngredients(iJson.data || []);
          setAllRecipes(rJson.data || []);
          setCategories(catJson.data || []);
        } catch (err) { console.error('Library fetch failed:', err); }
      })();
    }
  }, [mode, libraryLang]);


  /* ── Fetch recipe ───────────────────────────────────────────────── */
  const fetchRecipe = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/recipes/${id}${shownLang ? `?lang=${shownLang}` : ''}`);
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
  }, [id, shownLang]);

  useEffect(() => { fetchRecipe(); }, [fetchRecipe]);

  /* ── Offline download status (native only — Android/Electron server-mode
     offline cache, opt-in per recipe alongside the whole-library cache) ── */
  useEffect(() => {
    if (!isNative() || !id) return;
    import('../lib/offlineStore').then(({ isRecipeDownloaded }) => isRecipeDownloaded(id)).then(setDownloaded).catch(() => {});
  }, [id]);

  const handleToggleDownload = async () => {
    if (!id || !recipe) return;
    setDownloading(true);
    try {
      const { downloadRecipeOffline, removeDownloadedRecipe } = await import('../lib/offlineStore');
      if (downloaded) {
        await removeDownloadedRecipe(id);
        setDownloaded(false);
      } else {
        await downloadRecipeOffline(recipe as unknown as { id: string } & Record<string, unknown>);
        setDownloaded(true);
      }
    } catch (err) {
      console.error('Offline download toggle failed:', err);
    } finally {
      setDownloading(false);
    }
  };

  /* ── AI recipe translation ──────────────────────────────────────── */
  // English is the app's base language, never a translation target.
  const [aiTranslateLang, setAiTranslateLang] = useState(listLanguages().find(l => l.code !== 'en')?.code || '');
  const [aiTranslating, setAiTranslating] = useState(false);
  const [aiTranslateError, setAiTranslateError] = useState<string | null>(null);

  // If the target language ever matches the recipe's own written language
  // (e.g. once `recipe` finishes loading after this state's initial guess),
  // bump to the next different language rather than offering a no-op translate.
  useEffect(() => {
    const baseLang = recipe?.language_code || draft.language_code;
    if (baseLang && aiTranslateLang === baseLang) {
      setAiTranslateLang(listLanguages().find(l => l.code !== baseLang && l.code !== 'en')?.code || aiTranslateLang);
    }
  }, [recipe?.language_code, draft.language_code]);

  const handleAiTranslate = async () => {
    if (!id) return;
    const langLabel = languageLabel(aiTranslateLang);
    if (!window.confirm(t('recipeDetail.aiTranslateConfirm', { lang: langLabel }))) return;
    setAiTranslating(true);
    setAiTranslateError(null);
    try {
      // LLM translation of a full recipe (title/description/steps/notes) can take
      // several minutes on local CPU-only Ollama inference — same ceiling as
      // RecipeImport.tsx's parse call, just above the backend's own 600s cap.
      const res = await apiFetch(`/api/recipes/${id}/translate/${aiTranslateLang}`, { method: 'POST', timeoutMs: 650_000 });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('errors.translationFailed'));
      await fetchRecipe();
    } catch (err) {
      setAiTranslateError(err instanceof Error ? err.message : t('errors.translationFailed'));
    } finally {
      setAiTranslating(false);
    }
  };

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
  const scaleNum = (qty: number | null): number | null => {
    if (qty === null) return null;
    if (!recipe) return qty;
    return (qty * servings) / recipe.servings;
  };
  const scale = (qty: number | null): string => {
    const v = scaleNum(qty);
    if (v === null) return '';
    return v % 1 === 0 ? String(v) : v.toFixed(1);
  };

  /** Scales to the current portion count AND restates in the chosen system.
   *
   *  toSystem() returns null for anything it must not touch — a countable
   *  unit ("2 pz"), a vague one ("q.b."), a spoon, or a unit already in the
   *  requested system — and the original is rendered unchanged in every one
   *  of those cases. A quantityText with no number ("a pinch") never even
   *  reaches it. */
  const formatAmount = (qty: number | null, unitSymbol?: string | null, quantityText?: string | null): string => {
    const v = scaleNum(qty);
    if (v === null) return quantityText || '';
    const fallback = `${v % 1 === 0 ? v : v.toFixed(1)}${unitSymbol ? ` ${unitSymbol}` : quantityText ? ` ${quantityText}` : ''}`;
    if (!unitSymbol) return fallback;
    const converted = toSystem(v, unitSymbol, displaySystem);
    return converted ? `${converted.value} ${converted.symbol}` : fallback;
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
    quantity: ing.quantity !== null ? formatAmount(ing.quantity, ing.unitSymbol, ing.quantityText) : '',
  }));

  /** The same context, narrowed to one step: an inline reference inside a
   *  step that says it uses 500 of the 620 g of flour should read "500 g",
   *  not the recipe's total. It used to read the total for every step,
   *  because the only context the renderer ever got was the recipe-wide
   *  one above — the amount picked when the reference was inserted went
   *  into stepIngredients and was then never shown anywhere in the text. */
  const stepTextIngredientsFor = (step: { stepIngredients?: StepIngredientRef[] | null }) => {
    const refs = step.stepIngredients || [];
    if (refs.length === 0) return stepTextIngredients;
    return stepTextIngredients.map(ctx => {
      const ref = refs.find(r => r.ingredientSortOrder === ctx.sortOrder);
      if (!ref) return ctx;
      const ing = (recipe?.ingredients || []).find(i => i.sortOrder === ctx.sortOrder);
      if (!ing) return ctx;
      if (ref.amountMode === 'absolute') {
        return {
          ...ctx,
          stepQuantity: ref.quantity != null
            ? formatAmount(ref.quantity, ref.unitSymbol || ing.unitSymbol)
            : undefined,
        };
      }
      const consumed = stepIngredientConsumption(ref, { sortOrder: ing.sortOrder, quantity: ing.quantity, unitSymbol: ing.unitSymbol });
      return { ...ctx, stepQuantity: consumed != null ? formatAmount(consumed, ing.unitSymbol) : undefined };
    });
  };
  const stepTextTools = (recipe?.tools || []).map(t => ({ id: t.id, name: t.translated_name || t.name }));
  const stepTextTechniques = allTechniques.map(t => ({ id: t.id, name: t.translated_name || t.name }));

  /* ── Resolve a step's linked ingredients + their portion of the total ── */
  /** Steps in the order they are cooked — the order "how much is left by
   *  now" has to be counted in. */
  const sortedRecipeSteps = [...(recipe?.steps || [])].sort((a, b) => a.stepNumber - b.stepNumber);

  const stepIngredientList = (step: Step) => {
    if (!recipe || !step.stepIngredients?.length) return [];
    const stepIndex = Math.max(0, sortedRecipeSteps.findIndex(s => s.id === step.id));
    return step.stepIngredients.map(ref => {
      const ing = recipe.ingredients.find(i => i.sortOrder === ref.ingredientSortOrder);
      if (!ing) return null;
      const totals = { sortOrder: ing.sortOrder, quantity: ing.quantity, unitSymbol: ing.unitSymbol };
      // What the recipe still has of this ingredient once the steps before
      // this one have taken their share, and what is left after this one
      // does too. A recipe that pours 500 of its 620 g of flour into step 4
      // has 120 g for step 7, and kitchen mode is exactly where being told
      // that (rather than "620 g", the amount in the jar at the start)
      // decides whether the dish works.
      const before = remainingBeforeStep(sortedRecipeSteps, stepIndex, totals);
      const used = stepIngredientConsumption(ref, totals);
      const after = before != null && used != null ? Math.max(0, before - used) : null;
      if (ref.amountMode === 'absolute') {
        return {
          sortOrder: ing.sortOrder,
          name: ing.ingredientName || ing.subRecipeTitle || t('shopping.ingredientFallback'),
          quantity: ref.quantity != null ? scale(ref.quantity) : '',
          unitSymbol: ref.unitSymbol || ing.unitSymbol || '',
          portionPct: 100,
          remainingAfter: after != null ? scale(after) : '',
          totalUnitSymbol: ing.unitSymbol || '',
        };
      }
      const portionQty = ing.quantity !== null ? ing.quantity * ref.portion : null;
      return {
        sortOrder: ing.sortOrder,
        name: ing.ingredientName || ing.subRecipeTitle || t('shopping.ingredientFallback'),
        quantity: scale(portionQty),
        unitSymbol: ing.unitSymbol || '',
        portionPct: Math.round(ref.portion * 100),
        remainingAfter: after != null ? scale(after) : '',
        totalUnitSymbol: ing.unitSymbol || '',
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  };

  /* ── Tick one of a step's ingredients off (cooking mode) ───────── */
  const toggleStepIngredientChecked = (key: string) => {
    setCheckedIngredients(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  /* ── Toggle step complete (cooking mode) ────────────────────────── */
  // Same count both cook-mode branches show: every section's steps when the
  // recipe has sub-recipes, the recipe's own otherwise.
  const cookStepTotal = cookSequence && cookSequence.length > 1
    ? cookSequence.reduce((n, section) => n + section.steps.length, 0)
    : (recipe?.steps?.length ?? 0);
  // Ticking the last step logs the cook. Progress survives leaving cook
  // mode (see the localStorage effects above), so this remembers the cook
  // was logged — re-ticking the last step, or coming back to a finished
  // cook, must not count it twice.
  const cookLoggedKey = `smartchef.cookLogged.${id}`;
  const cookLogged = () => {
    try { return localStorage.getItem(cookLoggedKey) === '1'; } catch { return false; }
  };
  const setCookLogged = (logged: boolean) => {
    try { logged ? localStorage.setItem(cookLoggedKey, '1') : localStorage.removeItem(cookLoggedKey); } catch { /* at worst logs twice */ }
  };
  // The latest ticks, ahead of the render: two taps in one frame must each
  // build on the other, and the "was it just finished" check needs the
  // set as it was right before this tap.
  const completedRef = useRef(completedSteps);
  completedRef.current = completedSteps;
  const toggleStep = (key: string) => {
    const prev = completedRef.current;
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    completedRef.current = next;
    setCompletedSteps(next);
    if (next.size === 0) setCookLogged(false);
    else if (cookStepTotal > 0 && next.size >= cookStepTotal && prev.size < cookStepTotal && !cookLogged()) {
      setCookLogged(true);
      void handleLogCooked();
    }
  };
  /* ── Enter cooking mode — a finished cook starts over ───────────────── */
  const startCooking = () => {
    if (cookLogged()) {
      setCookLogged(false);
      try {
        localStorage.removeItem(`smartchef.cookProgress.${id}`);
        localStorage.removeItem(`smartchef.cookIngredients.${id}`);
      } catch { /* nothing saved to clear */ }
      setCheckedIngredients(new Set());
    }
    setCompletedSteps(new Set());
    setMode('cook');
  };

  /* ── Save recipe (edit mode) ────────────────────────────────────── */
  // Captured under a different name so handleSave below can shadow `draft`
  // locally (see its own comment) without a TDZ conflict against the outer
  // state binding of the same name.
  const outerDraft = draft;
  // Accepts an explicit draft (raw-text mode's handleSaveClick, right after
  // parsing new JSON) so a save can never race the setDraft() that would
  // otherwise need a render to land before this function's own `draft`
  // closure saw it.
  const handleSave = async (explicitDraft?: Partial<Recipe>) => {
    const draft = explicitDraft ?? outerDraft;
    if (!id || !draft.title) return;
    setSaving(true);
    try {
      // Any tool not already in the library (pasted from raw-text JSON,
      // never confirmed via the Kitchen Tools grid) gets created for real
      // now — its id up to this point was only a locally-generated
      // placeholder, not a real toolId the backend can save a reference to.
      const resolvedToolIds: string[] = [];
      for (const tool of draft.tools || []) {
        if (allTools.some(at => at.id === tool.id)) {
          resolvedToolIds.push(tool.id);
          continue;
        }
        const toolRes = await apiFetch('/api/tools', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tool.name }),
        });
        const toolJson = await toolRes.json();
        if (toolRes.ok) resolvedToolIds.push(toolJson.data.id);
      }

      const body = {
        title: draft.title,
        description: draft.description || '',
        storageInstructions: draft.storage_instructions || undefined,
        tips: draft.tips || undefined,
        difficulty: draft.difficulty || 'medium',
        servings: draft.servings || 4,
        prepTimeMin: draft.prep_time_min || undefined,
        cookTimeMin: draft.cook_time_min || undefined,
        restTimeMin: draft.rest_time_min || undefined,
        rating: draft.rating === undefined ? recipe?.rating ?? null : draft.rating,
        tags: draft.tags || [],
        regions: draft.regions || [],
        regionCoords: draft.region_coords || {},
        yieldAmount: draft.yield_amount || undefined,
        yieldUnitId: draft.yield_unit_id || undefined,
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
          groupName: ing.groupName || undefined,
          substituteFor: ing.substituteFor ?? null,
          translations: ing.translations || [],
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
        toolIds: resolvedToolIds,
      };

      const res = await apiFetch(`/api/recipes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const result = await res.json().catch(() => ({}));
        throw new Error(result.error ? JSON.stringify(result.error) : t('errors.saveFailedStatus', { status: res.status }));
      }
      await fetchRecipe();
      setMode('view');
    } catch (err) {
      console.error('Save failed:', err);
      alert(err instanceof Error ? err.message : t('errors.saveFailed'));
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
      <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-10 w-10 border-[3px] border-primary/20 border-t-primary" />
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('recipeDetail.loadingRecipe')}</p>
        </div>
      </div>
    );
  }
  if (!recipe) {
    return (
      <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 flex items-center justify-center">
        <div className="text-center">
          <span className="material-symbols-outlined text-6xl text-zinc-300 dark:text-zinc-600 mb-4 block">error</span>
          <p className="text-zinc-500 dark:text-zinc-400 font-medium">{t('recipeDetail.recipeNotFound')}</p>
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
        <header className="sticky top-0 z-50 bg-zinc-900 border-b border-zinc-800 px-6 py-4 flex items-center justify-between" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
          <button onClick={() => setMode('view')} className="flex items-center gap-2 text-zinc-400 dark:text-zinc-500 hover:text-white transition-colors">
            <span className="material-symbols-outlined">arrow_back</span>
            <span className="text-sm font-bold">{t('recipeDetail.exitKitchen')}</span>
          </button>
          <h2 className="text-lg font-headline font-bold text-white truncate max-w-md">{recipe.translated_title || recipe.title}</h2>
          <div className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('recipeDetail.stepsProgress', { done: completedSteps.size, total: flatSteps.length })}</div>
        </header>

        <div className="h-1 bg-zinc-800">
          <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>

        <main className="max-w-3xl mx-auto px-6 py-10 space-y-8">
          {flatSteps.map(({ key, section, step, isFirstOfSection }) => {
            const done = completedSteps.has(key);
            // How much of each ingredient this step takes, and what the
            // section has left afterwards — the same arithmetic the plain
            // kitchen mode does, against this section's own step order
            // rather than the main recipe's.
            const sectionSteps = [...section.steps].sort((a, b) => a.stepNumber - b.stepNumber);
            const stepIndexInSection = Math.max(0, sectionSteps.findIndex(s => s.id === step.id));
            const usedHere = (sortOrder: number) => {
              const ref = (step.stepIngredients || []).find(r => r.ingredientSortOrder === sortOrder);
              const ing = section.ingredients.find(i => i.sortOrder === sortOrder);
              if (!ref || !ing) return null;
              const totals = { sortOrder, quantity: ing.quantity, unitSymbol: ing.unitSymbol };
              const used = stepIngredientConsumption(ref, totals);
              const before = remainingBeforeStep(sectionSteps, stepIndexInSection, totals);
              return {
                ref,
                name: ing.ingredientName,
                unitSymbol: ref.amountMode === 'absolute' ? (ref.unitSymbol || ing.unitSymbol) : ing.unitSymbol,
                totalUnitSymbol: ing.unitSymbol,
                used,
                after: before != null && used != null ? Math.max(0, before - used) : null,
              };
            };
            const sectionIngredients = section.ingredients.map(ing => {
              const here = usedHere(ing.sortOrder);
              return {
                sortOrder: ing.sortOrder,
                name: ing.ingredientName,
                quantity: ing.quantity != null ? `${ing.quantity}${ing.unitSymbol ? ' ' + ing.unitSymbol : ''}` : '',
                stepQuantity: here?.used != null
                  ? `${formatEditorAmount(here.used, here.unitSymbol)}`
                  : undefined,
              };
            });
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
                      done ? 'bg-primary text-white' : 'bg-zinc-700 text-zinc-300 dark:text-zinc-600'
                    }`}>
                      {done ? <span className="material-symbols-outlined">check</span> : step.stepNumber.toString().padStart(2, '0')}
                    </div>
                    <div className="flex-1">
                      <h3 className={`font-headline font-bold text-xl mb-3 ${done ? 'text-primary line-through' : 'text-white'}`}>
                        {step.title || t('recipeDetail.stepNumber', { number: step.stepNumber })}
                      </h3>
                      <ResolvedImage src={step.imageUrl} className="w-full max-h-64 object-cover rounded-2xl mb-4" />
                      <p className="text-zinc-300 dark:text-zinc-600 leading-relaxed text-[15px] mb-4">
                        <RenderStepText text={step.description} ingredients={sectionIngredients} tools={sectionTools} techniques={stepTextTechniques} />
                      </p>

                      {(step.stepIngredients || []).length > 0 && (
                        <ul className="mb-4 space-y-1">
                          {(step.stepIngredients || []).map((ref, i) => {
                            const here = usedHere(ref.ingredientSortOrder);
                            if (!here) return null;
                            const itemKey = `${key}#${ref.ingredientSortOrder}`;
                            const ticked = checkedIngredients.has(itemKey);
                            const portionPct = ref.amountMode === 'absolute' ? 100 : Math.round((ref.portion ?? 1) * 100);
                            return (
                              <li key={i}>
                                <button
                                  type="button"
                                  onClick={() => toggleStepIngredientChecked(itemKey)}
                                  aria-pressed={ticked}
                                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${
                                    ticked ? 'bg-primary/10' : 'bg-zinc-700/30 hover:bg-zinc-700/50'
                                  }`}
                                >
                                  <span className={`material-symbols-outlined text-[20px] shrink-0 ${ticked ? 'text-primary' : 'text-zinc-500'}`}>
                                    {ticked ? 'check_box' : 'check_box_outline_blank'}
                                  </span>
                                  <span className={`flex-1 min-w-0 text-sm font-bold truncate ${ticked ? 'text-primary line-through' : 'text-zinc-200'}`}>
                                    {here.name}
                                    {portionPct < 100 ? <span className="ml-1.5 font-medium text-zinc-400">({portionPct}%)</span> : null}
                                  </span>
                                  <span className="shrink-0 text-right">
                                    <span className={`block text-sm font-bold tabular-nums ${ticked ? 'text-primary' : 'text-white'}`}>
                                      {here.used != null ? formatEditorAmount(here.used, here.unitSymbol) : ''}
                                    </span>
                                    {here.after != null && (
                                      <span className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                                        {t('recipeDetail.leftAfter', { amount: formatEditorAmount(here.after, here.totalUnitSymbol) })}
                                      </span>
                                    )}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}

                      {step.toolIds.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-4">
                          {step.toolIds.map(tid => {
                            const tool = section.tools.find(t => t.id === tid);
                            if (!tool) return null;
                            return (
                              <div key={tid} className="flex items-center gap-1.5 px-2 py-1 bg-zinc-700/50 rounded-lg border border-zinc-600/30">
                                <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-primary text-sm" />
                                <span className="text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500">{tool.name}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {step.techniqueIds && step.techniqueIds.length > 0 && (
                        <div className="flex flex-wrap gap-2 mb-4">
                          {step.techniqueIds.map(tid => {
                            const tech = section.techniques.find(t => t.id === tid);
                            if (!tech) return null;
                            return (
                              <div key={tid} className="flex items-center gap-1.5 px-2 py-1 bg-zinc-700/50 rounded-lg border border-zinc-600/30">
                                <RenderFaIcon name={tech.icon || 'TbFlame'} className="text-primary text-sm" />
                                <span className="text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500">{tech.name}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {step.durationMin && (
                        <button
                          type="button"
                          onClick={() => {
                            requestTimerNotifications();
                            startCookTimer({
                              // Step numbers restart inside each sub-recipe,
                              // so the section has to be part of the id or
                              // two timers would collide.
                              id: `${section.recipeId}:${step.stepNumber}`,
                              label: `${section.recipeTitle} · ${step.title || t('recipeDetail.stepNumber', { number: step.stepNumber })}`,
                              minutes: step.durationMin!,
                            });
                          }}
                          className="flex items-center gap-2 mb-4 px-3 py-1.5 rounded-full border border-zinc-600/60 text-sm text-zinc-300 hover:border-primary hover:text-primary transition-colors"
                        >
                          <span className="material-symbols-outlined text-sm">timer</span>
                          {t('recipeDetail.durationMinutes', { count: step.durationMin })}
                          <span className="text-[10px] font-black uppercase tracking-wider opacity-70">{t('cookTimer.start')}</span>
                        </button>
                      )}

                      {step.notes && (
                        <div className="bg-primary/10 border border-primary/20 rounded-2xl p-4 mb-6">
                          <div className="flex items-center gap-2 text-primary mb-1">
                            <span className="material-symbols-outlined text-sm text-[18px]">lightbulb</span>
                            <span className="text-[10px] uppercase font-bold tracking-wider">{t('recipeDetail.chefsNote')}</span>
                          </div>
                          <p className="text-sm text-zinc-300 dark:text-zinc-600 italic">{step.notes}</p>
                        </div>
                      )}

                      <button
                        onClick={() => toggleStep(key)}
                        className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-sm transition-all ${
                          done ? 'bg-zinc-700 text-zinc-300 dark:text-zinc-600 hover:bg-zinc-600' : 'bg-primary text-white hover:bg-primary/80'
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
              <p className="text-zinc-400 dark:text-zinc-500">{t('recipeDetail.allStepsCompleted')}</p>
              <p className="mt-2 flex items-center justify-center gap-1.5 text-sm font-bold text-primary">
                <span className="material-symbols-outlined text-base">check_circle</span>
                {t('recipeDetail.loggedAsCooked')} · {t('recipeDetail.cookedTimes', { count: recipe.times_cooked })}
              </p>
              <button onClick={() => setMode('view')} className="mt-6 px-8 py-3 bg-primary text-white rounded-full font-bold hover:bg-primary/80 transition-colors">
                {t('recipeDetail.backToRecipe')}
              </button>
            </div>
          )}
        </main>

        {/* Fixed to the bottom of the viewport; the padding keeps the last
            step's controls clear of it. */}
        <div className="h-24" />
        <CookTimerBar />
      </div>
    );
  }

  if (mode === 'cook') {
    const sortedSteps = [...(recipe.steps || [])].sort((a, b) => a.stepNumber - b.stepNumber);
    const progress = recipe.steps.length > 0 ? (completedSteps.size / recipe.steps.length) * 100 : 0;

    return (
      <div className="min-h-screen bg-zinc-900 text-white font-body">
        {/* Header */}
        <header className="sticky top-0 z-50 bg-zinc-900 border-b border-zinc-800 px-6 py-4 flex items-center justify-between" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
          <button onClick={() => setMode('view')} className="flex items-center gap-2 text-zinc-400 dark:text-zinc-500 hover:text-white transition-colors">
            <span className="material-symbols-outlined">arrow_back</span>
            <span className="text-sm font-bold">{t('recipeDetail.exitKitchen')}</span>
          </button>
          <h2 className="text-lg font-headline font-bold text-white truncate max-w-md">{recipe.translated_title || recipe.title}</h2>
          <div className="flex items-center gap-3">
            {wakeLockState === 'active' && (
              <span title={t('cookTimer.screenStaysOn')} className="flex items-center gap-1 text-[11px] font-bold text-primary">
                <span className="material-symbols-outlined text-[15px]">visibility</span>
                {t('cookTimer.screenOn')}
              </span>
            )}
            <span className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('recipeDetail.stepsProgress', { done: completedSteps.size, total: recipe.steps.length })}</span>
          </div>
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
                    done ? 'bg-primary text-white' : 'bg-zinc-700 text-zinc-300 dark:text-zinc-600'
                  }`}>
                    {done ? <span className="material-symbols-outlined">check</span> : step.stepNumber.toString().padStart(2, '0')}
                  </div>
                  <div className="flex-1">
                    <h3 className={`font-headline font-bold text-xl mb-3 ${done ? 'text-primary line-through' : 'text-white'}`}>
                      {step.translatedTitle || step.title || t('recipeDetail.stepNumber', { number: step.stepNumber })}
                    </h3>
                    <ResolvedImage src={step.imageUrl} className="w-full max-h-64 object-cover rounded-2xl mb-4" />
                    <p className="text-zinc-300 dark:text-zinc-600 leading-relaxed text-[15px] mb-4">
                      <RenderStepText text={step.translatedDescription || step.description} ingredients={stepTextIngredientsFor(step)} tools={stepTextTools} techniques={stepTextTechniques} />
                    </p>

                    {/* Kitchen mode gets a checklist, not a row of chips:
                        with both hands busy the question is "have I put the
                        flour in yet", and a tap per line answers it. Ticks
                        live in the same per-device localStorage the step
                        progress does — see the cookProgress effects. */}
                    {stepIngredientList(step).length > 0 && (
                      <ul className="mb-4 space-y-1">
                        {stepIngredientList(step).map((si, i) => {
                          const itemKey = `${stepKey}#${si.sortOrder}`;
                          const ticked = checkedIngredients.has(itemKey);
                          return (
                            <li key={i}>
                              <button
                                type="button"
                                onClick={() => toggleStepIngredientChecked(itemKey)}
                                aria-pressed={ticked}
                                className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${
                                  ticked ? 'bg-primary/10' : 'bg-zinc-700/30 hover:bg-zinc-700/50'
                                }`}
                              >
                                <span className={`material-symbols-outlined text-[20px] shrink-0 ${ticked ? 'text-primary' : 'text-zinc-500'}`}>
                                  {ticked ? 'check_box' : 'check_box_outline_blank'}
                                </span>
                                <span className={`flex-1 min-w-0 text-sm font-bold truncate ${ticked ? 'text-primary line-through' : 'text-zinc-200'}`}>
                                  {si.name}
                                  {si.portionPct < 100 ? <span className="ml-1.5 font-medium text-zinc-400">({si.portionPct}%)</span> : null}
                                </span>
                                <span className="shrink-0 text-right">
                                  <span className={`block text-sm font-bold tabular-nums ${ticked ? 'text-primary' : 'text-white'}`}>
                                    {si.quantity ? `${si.quantity}${si.unitSymbol ? ' ' + si.unitSymbol : ''}` : ''}
                                  </span>
                                  {si.remainingAfter !== '' && (
                                    <span className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                                      {t('recipeDetail.leftAfter', { amount: `${si.remainingAfter}${si.totalUnitSymbol ? ' ' + si.totalUnitSymbol : ''}` })}
                                    </span>
                                  )}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {/* Step Tools */}
                    {step.toolIds && step.toolIds.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-4">
                        {step.toolIds.map(tid => {
                          const tool = recipe.tools?.find(t => t.id === tid);
                          if (!tool) return null;
                          return (
                            <div key={tid} className="flex items-center gap-1.5 px-2 py-1 bg-zinc-700/50 rounded-lg border border-zinc-600/30">
                              <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-primary text-sm" />
                              <span className="text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500">{tool.translated_name || tool.name}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Step Techniques */}
                    {step.techniqueIds && step.techniqueIds.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-4">
                        {step.techniqueIds.map(tid => {
                          const tech = recipe.techniques?.find(t => t.id === tid);
                          if (!tech) return null;
                          return (
                            <div key={tid} className="flex items-center gap-1.5 px-2 py-1 bg-zinc-700/50 rounded-lg border border-zinc-600/30">
                              <RenderFaIcon name={tech.icon || 'TbFlame'} className="text-primary text-sm" />
                              <span className="text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500">{tech.translated_name || tech.name}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {step.durationMin && (
                      <button
                        type="button"
                        onClick={() => {
                          requestTimerNotifications();
                          startCookTimer({
                            id: `${recipe.id}:${step.stepNumber}`,
                            label: step.translatedTitle || step.title || t('recipeDetail.stepNumber', { number: step.stepNumber }),
                            minutes: step.durationMin!,
                          });
                        }}
                        className="flex items-center gap-2 mb-4 px-3 py-1.5 rounded-full border border-zinc-600/60 text-sm text-zinc-300 hover:border-primary hover:text-primary transition-colors"
                      >
                        <span className="material-symbols-outlined text-sm">timer</span>
                        {t('recipeDetail.durationMinutes', { count: step.durationMin })}
                        <span className="text-[10px] font-black uppercase tracking-wider opacity-70">{t('cookTimer.start')}</span>
                      </button>
                    )}

                    {/* Step Note */}
                    {(step.translatedNotes || step.notes) && (
                      <div className="bg-primary/10 border border-primary/20 rounded-2xl p-4 mb-6">
                        <div className="flex items-center gap-2 text-primary mb-1">
                          <span className="material-symbols-outlined text-sm text-[18px]">lightbulb</span>
                          <span className="text-[10px] uppercase font-bold tracking-wider">{t('recipeDetail.chefsNote')}</span>
                        </div>
                        <p className="text-sm text-zinc-300 dark:text-zinc-600 italic">{step.translatedNotes || step.notes}</p>
                      </div>
                    )}

                    <button
                      onClick={() => toggleStep(stepKey)}
                      className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-sm transition-all ${
                        done
                          ? 'bg-zinc-700 text-zinc-300 dark:text-zinc-600 hover:bg-zinc-600'
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
              <p className="text-zinc-400 dark:text-zinc-500">{t('recipeDetail.allStepsCompleted')}</p>
              <p className="mt-2 flex items-center justify-center gap-1.5 text-sm font-bold text-primary">
                <span className="material-symbols-outlined text-base">check_circle</span>
                {t('recipeDetail.loggedAsCooked')} · {t('recipeDetail.cookedTimes', { count: recipe.times_cooked })}
              </p>
              <button onClick={() => setMode('view')} className="mt-6 px-8 py-3 bg-primary text-white rounded-full font-bold hover:bg-primary/80 transition-colors">
                {t('recipeDetail.backToRecipe')}
              </button>
            </div>
          )}
        </main>

        {/* Fixed to the bottom of the viewport; the padding keeps the last
            step's controls clear of it. */}
        <div className="h-24" />
        <CookTimerBar />
      </div>
    );
  }

  /* ═════════════════════════════════════════════════════════════════
     EDIT MODE
     ═════════════════════════════════════════════════════════════════ */
  if (mode === 'edit') {
    const updateDraft = (field: string, value: unknown) =>
      setDraft(prev => ({ ...prev, [field]: value }));

    /* ── Folding the two long editors ──────────────────────────────
       Both lists work the same way: each card folds to a one-line
       summary on its own, and the header folds/unfolds the lot or hides
       the section entirely. Keyed by index rather than by row id because
       a draft row has no id until it is saved. */
    const ingredientCount = (draft.ingredients || []).length;
    const stepCount = (draft.steps || []).length;
    const allIngredientsCollapsed = ingredientCount > 0 && collapsedIngredients.size >= ingredientCount;
    const allStepsCollapsed = stepCount > 0 && collapsedSteps.size >= stepCount;
    const toggleIn = (set: Set<number>, idx: number) => {
      const next = new Set(set);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    };
    const toggleIngredientCollapsed = (idx: number) => setCollapsedIngredients(prev => toggleIn(prev, idx));
    const toggleStepCollapsed = (idx: number) => setCollapsedSteps(prev => toggleIn(prev, idx));
    const toggleAllIngredients = () =>
      setCollapsedIngredients(allIngredientsCollapsed ? new Set() : new Set((draft.ingredients || []).map((_, i) => i)));
    const toggleAllSteps = () =>
      setCollapsedSteps(allStepsCollapsed ? new Set() : new Set((draft.steps || []).map((_, i) => i)));

    /** Every name this ingredient answers to, for the "show as" box on an
     *  inline step reference: what the recipe calls it, plus the library
     *  row's own name, plural and synonyms and its translations. Synonyms
     *  have been collected for search since db/migrations/035_synonyms.sql
     *  and had nowhere to be used — this is where they earn their keep,
     *  letting a step read "setaccia la farina" while still pointing at
     *  "Farina di grano tipo 00". */
    const ingredientAliases = (ing: Ingredient): string[] => {
      const row = allIngredients.find(i => i.id === ing.ingredientId);
      return uniqueNames([
        ing.ingredientName,
        row?.translated_name,
        row?.name,
        row?.plural_name,
        ing.ingredientPluralName,
        ...(row?.synonyms ?? []),
        ...((row?.translations ?? []).map(tr => tr.text)),
      ]);
    };

    const enterRawTextMode = () => {
      setRawText(JSON.stringify(draft, null, 2));
      setRawTextError(null);
      setRawTextMode(true);
    };
    // Returns the parsed draft (and leaves raw mode active with an error
    // shown) on invalid JSON — null in that case — so callers — the toggle
    // button and the Save button both — can bail out instead of silently
    // discarding whatever the user typed.
    const applyRawText = (): Partial<Recipe> | null => {
      try {
        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(t('errors.expectedJsonObject'));
        }
        // Merge onto the current draft rather than replacing it wholesale.
        // ingredients/steps/tools/techniques also accept the same looser
        // shape the AI import pipeline produces (steps as plain sentences,
        // tools/techniques as plain names, ingredients as {name, quantity,
        // unit, note}) via coerce*() below — anything that still isn't
        // recognizable just becomes an empty array instead of undefined,
        // which is what used to crash every .map() in the form below to a
        // blank screen.
        const merged: Partial<Recipe> = { ...draft, ...parsed };
        if ('ingredients' in parsed) merged.ingredients = coerceIngredients(parsed.ingredients) as unknown as Ingredient[];
        if ('steps' in parsed) merged.steps = coerceSteps(parsed.steps) as unknown as Step[];
        if ('tools' in parsed) merged.tools = coerceNamedEntities(parsed.tools) as unknown as Tool[];
        if ('techniques' in parsed) merged.techniques = coerceNamedEntities(parsed.techniques) as unknown as Technique[];
        const arrayFields: (keyof Recipe)[] = ['ingredients', 'steps', 'tools', 'techniques', 'tags', 'regions', 'sources', 'translations'];
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
    const handleSaveClick = () => {
      if (rawTextMode) {
        const parsed = applyRawText();
        if (!parsed) return;
        setRawTextMode(false);
        handleSave(parsed);
        return;
      }
      handleSave();
    };
    const toggleRawText = () => {
      if (rawTextMode) {
        if (!applyRawText()) return;
        setRawTextMode(false);
      } else {
        enterRawTextMode();
      }
    };
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
          const next: Step = {
            ...s,
            stepIngredients: has
              ? existing.filter(si => si.ingredientSortOrder !== ingredientSortOrder)
              : [...existing, { ingredientSortOrder, amountMode: 'fraction' as const, portion: 1 }],
          };
          // Unticking drops the pinned amount out of the sentence too —
          // an inline reference claiming "310 g" for an ingredient this
          // step no longer says it uses is worse than one that just names it.
          return withSyncedRefs(next, ingredientSortOrder, prev.ingredients || []);
        }),
      }));

    /** Re-states a step's {{ing:N}} tokens after its amount for that
     *  ingredient changed anywhere other than the insert popover.
     *
     *  Without this the token kept whatever amount was true when it was
     *  inserted: move the slider from 100% to 80% and the sentence still
     *  read "620 g of flour". `null` strips the pinned amount so the
     *  renderer falls back to the step's own data. */
    const withSyncedRefs = (step: Step, ingredientSortOrder: number, ingredients: Ingredient[]): Step => {
      const ref = (step.stepIngredients || []).find(si => si.ingredientSortOrder === ingredientSortOrder);
      const ing = ingredients.find(i => i.sortOrder === ingredientSortOrder);
      let amount: string | null = null;
      if (ref && ing) {
        if (ref.amountMode === 'absolute') {
          amount = ref.quantity != null
            ? formatEditorAmount(ref.quantity, ref.unitSymbol || ing.unitSymbol)
            : null;
        } else {
          const consumed = stepIngredientConsumption(ref, { sortOrder: ing.sortOrder, quantity: ing.quantity, unitSymbol: ing.unitSymbol });
          amount = consumed != null ? formatEditorAmount(consumed, ing.unitSymbol) : null;
        }
      }
      return { ...step, description: syncIngredientRefAmount(step.description || '', ingredientSortOrder, amount) };
    };

    /** Applies `patch` to one step-ingredient row, then brings that step's
     *  inline references back in line with it. */
    const patchStepIngredient = (
      stepIdx: number,
      ingredientSortOrder: number,
      patch: Partial<StepIngredientRef>,
    ) =>
      setDraft(prev => ({
        ...prev,
        steps: (prev.steps || []).map((s, i) => {
          if (i !== stepIdx) return s;
          const next: Step = {
            ...s,
            stepIngredients: (s.stepIngredients || []).map(si =>
              si.ingredientSortOrder === ingredientSortOrder ? { ...si, ...patch } : si
            ),
          };
          return withSyncedRefs(next, ingredientSortOrder, prev.ingredients || []);
        }),
      }));

    const updateStepIngredientPortion = (stepIdx: number, ingredientSortOrder: number, portion: number) =>
      patchStepIngredient(stepIdx, ingredientSortOrder, { portion });

    // Switches a step-ingredient between "% of total" and "exact amount" mode.
    const setStepIngredientMode = (stepIdx: number, ingredientSortOrder: number, amountMode: 'fraction' | 'absolute') =>
      patchStepIngredient(stepIdx, ingredientSortOrder, { amountMode });

    const updateStepIngredientAmount = (stepIdx: number, ingredientSortOrder: number, field: 'quantity' | 'unitId' | 'unitSymbol', value: unknown) =>
      patchStepIngredient(stepIdx, ingredientSortOrder, { [field]: value } as Partial<StepIngredientRef>);

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
        ingredients: [...(prev.ingredients || []), { id: '', sortOrder: (prev.ingredients?.length || 0), ingredientId: null, ingredientName: '', quantity: 1, unitId: null, isOptional: false, notes: '', groupName: null }],
      }));
    const getEntryType = (idx: number, ing: Ingredient): 'ingredient' | 'recipe' =>
      ingredientEntryTypes[idx] ?? (ing.subRecipeId ? 'recipe' : 'ingredient');
    // An ingredient can need matching two ways: parsed from raw-text with a
    // name but no library id yet, OR — for an already-saved recipe — an id
    // that no longer resolves to any row in allIngredients (the ingredient
    // was deleted, or hasn't synced to this device yet). Both cases used to
    // just render a blank, unexplained box; both now get the same
    // search/create-new treatment. Same idea for a dangling sub-recipe
    // reference, using the denormalized subRecipeTitle as the fallback text
    // since the linked recipe itself isn't in allRecipes to look up.
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
    /** Deleting an ingredient renumbers every row after it, so every
     *  reference keyed by sortOrder has to move with them: the steps'
     *  stepIngredients rows, the {{ing:N}} tokens inside the step text
     *  (which used to be left pointing at whatever row slid into that
     *  position), and any row marked as a substitute for this one. */
    const removeIngredient = (idx: number) =>
      setDraft(prev => ({
        ...prev,
        ingredients: (prev.ingredients || [])
          .filter((_, i) => i !== idx)
          .map((ing, i) => ({
            ...ing,
            sortOrder: i,
            substituteFor:
              ing.substituteFor == null ? null
              : ing.substituteFor === idx ? null
              : ing.substituteFor > idx ? ing.substituteFor - 1
              : ing.substituteFor,
          })),
        steps: (prev.steps || []).map(s => ({
          ...s,
          description: reindexIngredientRefs(s.description || '', idx),
          stepIngredients: (s.stepIngredients || [])
            .filter(si => si.ingredientSortOrder !== idx)
            .map(si => si.ingredientSortOrder > idx ? { ...si, ingredientSortOrder: si.ingredientSortOrder - 1 } : si),
        })),
      }));

    /** Marks a row as an alternative to another ingredient of the same
     *  recipe, or clears that. Chains are not a thing — a substitute for a
     *  substitute has no meaning the shopping list or the ingredient list
     *  could render — so the picker only offers ordinary rows and this
     *  clears anything pointing AT a row that just became a substitute
     *  itself. */
    const setSubstituteFor = (idx: number, target: number | null) =>
      setDraft(prev => ({
        ...prev,
        ingredients: (prev.ingredients || []).map((ing, i) => {
          if (i === idx) return { ...ing, substituteFor: target };
          if (target !== null && ing.substituteFor === idx) return { ...ing, substituteFor: null };
          return ing;
        }),
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

    // Inline "create new" without leaving the editor — same pattern as
    // RecipeCreate.tsx's identical handlers.
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
            autoTranslate: true,
          }),
          timeoutMs: 650_000,
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
        const newTool: Tool = { id: json.data.id, name, icon: null, category: null };
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

    return (
      <div className="min-h-screen bg-[#fafaf5] dark:bg-zinc-950 font-body">
        {/* Header */}
        <header className="bg-[#fafaf5] dark:bg-zinc-950 sticky top-0 z-50 border-b border-zinc-200/60 dark:border-zinc-700/60 px-8 py-4 flex items-center justify-between" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
          <button onClick={() => { setDraft(recipe); setRawTextMode(false); setRawTextError(null); setMode('view'); }} className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors">
            <span className="material-symbols-outlined">close</span>
            <span className="text-sm font-bold">{t('common.cancel')}</span>
          </button>
          <h2 className="text-lg font-headline font-bold text-zinc-800 dark:text-zinc-200">{t('recipeDetail.editRecipe')}</h2>
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
              onClick={handleDelete}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-red-500 hover:bg-red-50 rounded-full font-bold text-sm transition-all disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">delete</span>
              {t('common.delete')}
            </button>
            <button
              onClick={handleSaveClick}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2 bg-primary text-white rounded-full font-bold text-sm hover:bg-primary/90 transition-all disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-sm">{saving ? 'sync' : 'save'}</span>
              {saving ? t('recipeDetail.saving') : t('recipeDetail.saveRecipe')}
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
        <main className="max-w-7xl mx-auto px-6 py-10">
          {/* Two columns: what you actually edit on the left, everything
              that describes the recipe in a sticky rail on the right. As one
              1104px column the two big editors were cards 9 and 10, roughly
              five screens below the fold, behind eight metadata cards - and
              ~890px of the window was empty gutter either side of them. */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
            <div className="xl:col-span-8 space-y-8 min-w-0">
              {/* Title & description */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <label className="block mb-6">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold block">{t('recipeDetail.recipeTitle')}</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">
                      {t('recipeDetail.writtenIn')}
                      <select
                        value={draft.language_code || recipe.language_code || 'en'}
                        onChange={e => updateDraft('language_code', e.target.value)}
                        className="border-none bg-zinc-50 dark:bg-zinc-900 rounded-lg px-2 py-1 text-[11px] font-bold text-zinc-600 dark:text-zinc-400 focus:ring-2 focus:ring-primary/20 cursor-pointer"
                      >
                        {languages.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
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
                  <AutoTextarea
                    value={draft.description || ''}
                    onChange={e => updateDraft('description', e.target.value)}
                    className="w-full border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[150px] max-h-[50vh] overflow-y-auto"
                    placeholder={t('recipeDetail.shortDescriptionPlaceholder')}
                  />
                </label>
                <label className="block mb-6">
                  <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.storageInstructions')}</span>
                  <AutoTextarea
                    value={draft.storage_instructions || ''}
                    onChange={e => updateDraft('storage_instructions', e.target.value || null)}
                    className="w-full border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[110px] max-h-[40vh] overflow-y-auto"
                    placeholder={t('recipeDetail.storageInstructionsPlaceholder')}
                  />
                </label>
                <label className="block mb-6">
                  <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.tips')}</span>
                  <AutoTextarea
                    value={draft.tips || ''}
                    onChange={e => updateDraft('tips', e.target.value || null)}
                    className="w-full border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl p-4 text-sm resize-none focus:ring-2 focus:ring-primary/20 min-h-[110px] max-h-[40vh] overflow-y-auto"
                    placeholder={t('recipeDetail.tipsPlaceholder')}
                  />
                </label>
              </div>

              {/* Ingredients Editor */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <div className="flex items-center justify-between gap-3 mb-6">
                  <h3 className="font-headline font-bold text-xl">
                    {t('recipeDetail.ingredients')}
                    <span className="ml-2 text-sm font-bold text-zinc-300 dark:text-zinc-600 tabular-nums">{ingredientCount}</span>
                  </h3>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={toggleAllIngredients}
                      className="px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                    >
                      {allIngredientsCollapsed ? t('recipeDetail.expandAll') : t('recipeDetail.collapseAll')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIngredientsFolded(f => !f)}
                      aria-expanded={!ingredientsFolded}
                      title={ingredientsFolded ? t('recipeDetail.expandSection') : t('recipeDetail.collapseSection')}
                      className="w-9 h-9 rounded-full flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[20px]">{ingredientsFolded ? 'unfold_more' : 'unfold_less'}</span>
                    </button>
                  </div>
                </div>
                {ingredientsFolded ? (
                  <button
                    type="button"
                    onClick={() => setIngredientsFolded(false)}
                    className="w-full text-left text-sm text-zinc-400 dark:text-zinc-500 font-medium hover:text-primary transition-colors"
                  >
                    {t('recipeDetail.sectionFolded', { count: ingredientCount })}
                  </button>
                ) : (
                <>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  {(draft.ingredients || []).map((ing, idx) => (
                    /* @container: the fields inside lay themselves out from the CARD's
                       width rather than the viewport's. Two of these sit side by side in
                       an 8-of-12 column, so the old viewport-wide `xl:` 6/3/3 grid left
                       the ingredient name about 170px - name, type toggle, QTY and UNIT
                       all printing over each other. */
                    <div key={idx} className="@container bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl p-4 border border-zinc-100 dark:border-zinc-800">
                      {collapsedIngredients.has(idx) ? (
                        /* Folded: one line saying what this row is, and a
                           click to open it again. Everything a finished
                           ingredient still needs to show — its number, its
                           name, its amount, whether it is optional or an
                           alternative to something else — fits here, so a
                           twenty-ingredient recipe is a list you can read
                           rather than five screens of form. */
                        <button
                          type="button"
                          onClick={() => toggleIngredientCollapsed(idx)}
                          className="w-full flex items-center gap-2 text-left group/row"
                        >
                          <span className="w-6 h-6 shrink-0 rounded-lg bg-primary/10 text-primary text-[11px] font-bold flex items-center justify-center tabular-nums">{idx + 1}</span>
                          <span className="flex-1 min-w-0 truncate text-sm font-bold text-zinc-700 dark:text-zinc-300">
                            {ing.ingredientName || ing.subRecipeTitle || t('recipeDetail.unnamedIngredient')}
                          </span>
                          {ing.substituteFor != null && (
                            <span className="shrink-0 rounded-full bg-sky-50 dark:bg-sky-950/40 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-sky-700 dark:text-sky-400">
                              {t('recipeDetail.substitute')}
                            </span>
                          )}
                          {ing.isOptional && (
                            <span className="shrink-0 rounded-full bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-700 dark:text-amber-500">
                              {t('recipeDetail.optional')}
                            </span>
                          )}
                          <span className="shrink-0 text-xs font-semibold text-zinc-500 dark:text-zinc-400 tabular-nums">
                            {ing.quantity != null ? formatEditorAmount(ing.quantity, ing.unitSymbol) : ''}
                          </span>
                          <span className="material-symbols-outlined text-[18px] text-zinc-300 dark:text-zinc-600 group-hover/row:text-primary">expand_more</span>
                        </button>
                      ) : (
                      <>
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
                        <div className="flex items-center gap-2">
                          {/* `is_optional` has been on the row, in the
                              matrioska engine and in the pantry matcher
                              from the start — "optional ingredients never
                              count against a recipe" is the rule the whole
                              \"what can I cook\" feature rests on — with
                              nothing anywhere in the app that could set it.
                              Every ingredient was therefore mandatory, so
                              a recipe was hidden from the pantry over a
                              garnish. */}
                          <button
                            type="button"
                            onClick={() => updateIngredient(idx, 'isOptional', !ing.isOptional)}
                            aria-pressed={!!ing.isOptional}
                            title={t('recipeDetail.optionalHint')}
                            className={`px-3 py-1 rounded-full text-[9px] font-bold uppercase transition-colors ${
                              ing.isOptional
                                ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400'
                                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-400'
                            }`}
                          >
                            {t('recipeDetail.optional')}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleIngredientCollapsed(idx)}
                            title={t('recipeDetail.collapseRow')}
                            className="w-8 h-8 shrink-0 rounded-full text-zinc-300 dark:text-zinc-600 flex items-center justify-center transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-600 dark:hover:text-zinc-300"
                          >
                            <span className="material-symbols-outlined text-[18px]">unfold_less</span>
                          </button>
                          <button
                            onClick={() => removeIngredient(idx)}
                            title={t('common.delete')}
                            className="w-8 h-8 shrink-0 rounded-full text-zinc-300 dark:text-zinc-600 flex items-center justify-center transition-colors hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-500"
                          >
                            <span className="material-symbols-outlined text-[18px]">delete</span>
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-12 gap-3">
                        <div className="col-span-12 @lg:col-span-6">
                          <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.ingredient')}</label>
                          {getEntryType(idx, ing) === 'recipe' ? (
                            <Autocomplete
                              value={subRecipeDangling(ing) ? '' : (ing.subRecipeId || '')}
                              unmatchedLabel={subRecipeDangling(ing) ? (ing.subRecipeTitle || t('recipeDetail.ingredientNeedsMatching')) : undefined}
                              options={allRecipes.filter(r => r.id !== id).map(r => ({ id: r.id, label: r.translated_title || r.title }))}
                              onSelect={(subId, label) => {
                                updateIngredient(idx, 'subRecipeId', subId);
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
                              onSelect={(id2, label) => {
                                updateIngredient(idx, 'ingredientId', id2);
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
                                <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('import.newNameEnglish')}</label>
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
                        {/* "Or use this instead" — an alternative to one
                            of the other rows rather than a further thing
                            to buy. Only ordinary rows are offered as the
                            target: a substitute for a substitute has no
                            reading the ingredient list or the shopping
                            list could render. */}
                        <div className="col-span-12">
                          <label className="block text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('recipeDetail.substituteForLabel')}</label>
                          <select
                            value={ing.substituteFor ?? ''}
                            onChange={e => setSubstituteFor(idx, e.target.value === '' ? null : parseInt(e.target.value, 10))}
                            className="w-full border-none bg-white dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                          >
                            <option value="">{t('recipeDetail.substituteForNone')}</option>
                            {(draft.ingredients || []).map((other, otherIdx) => (
                              otherIdx === idx || other.substituteFor != null ? null : (
                                <option key={otherIdx} value={otherIdx}>
                                  {other.ingredientName || other.subRecipeTitle || t('recipeDetail.unnamedIngredient')}
                                </option>
                              )
                            ))}
                          </select>
                          {ing.substituteFor != null && (
                            <p className="text-[9px] text-sky-600 dark:text-sky-500 font-bold mt-1">{t('recipeDetail.substituteHint')}</p>
                          )}
                        </div>
                        <details className="col-span-12">
                          <summary className="cursor-pointer text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 select-none">{t('recipeDetail.ingredientTranslationsOptional')}</summary>
                          <TranslationsEditor
                            translations={ing.translations || []}
                            onChange={translations => updateIngredient(idx, 'translations', translations)}
                            showTitleDescription={false}
                            notesLabel={t('recipeDetail.chefsNoteIngredientPlaceholder')}
                            compact
                          />
                        </details>
                      </div>
                      </>
                      )}
                    </div>
                  ))}
                </div>
                {/* The way to add another one lives at the BOTTOM of the
                    list, where you are once you have filled the last row
                    in — a header button meant scrolling up, clicking, and
                    scrolling back down for every single ingredient. */}
                <button
                  onClick={addIngredient}
                  className="mt-4 w-full flex items-center justify-center gap-1.5 px-4 py-3 rounded-2xl border-2 border-dashed border-primary/30 text-primary text-sm font-bold hover:bg-primary/5 hover:border-primary/50 transition-colors"
                >
                  <span className="material-symbols-outlined text-base">add</span> {t('recipeDetail.addIngredient')}
                </button>
                </>
                )}
              </div>

              {/* Steps editor */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <div className="flex items-center justify-between gap-3 mb-6">
                  <h3 className="font-headline font-bold text-xl">
                    {t('recipeDetail.steps')}
                    <span className="ml-2 text-sm font-bold text-zinc-300 dark:text-zinc-600 tabular-nums">{stepCount}</span>
                  </h3>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={toggleAllSteps}
                      className="px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                    >
                      {allStepsCollapsed ? t('recipeDetail.expandAll') : t('recipeDetail.collapseAll')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setStepsFolded(f => !f)}
                      aria-expanded={!stepsFolded}
                      title={stepsFolded ? t('recipeDetail.expandSection') : t('recipeDetail.collapseSection')}
                      className="w-9 h-9 rounded-full flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[20px]">{stepsFolded ? 'unfold_more' : 'unfold_less'}</span>
                    </button>
                  </div>
                </div>
                {stepsFolded ? (
                  <button
                    type="button"
                    onClick={() => setStepsFolded(false)}
                    className="w-full text-left text-sm text-zinc-400 dark:text-zinc-500 font-medium hover:text-primary transition-colors"
                  >
                    {t('recipeDetail.stepsFolded', { count: stepCount })}
                  </button>
                ) : (
                <>
                <div className="space-y-4">
                  {(draft.steps || []).map((step, idx) => (
                    <div key={idx} className="bg-zinc-50 dark:bg-zinc-900 rounded-2xl p-6 relative group">
                      {collapsedSteps.has(idx) ? (
                        <button
                          type="button"
                          onClick={() => toggleStepCollapsed(idx)}
                          className="w-full flex items-center gap-3 text-left group/row"
                        >
                          <span className="w-8 h-8 shrink-0 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-sm tabular-nums">{idx + 1}</span>
                          <span className="flex-1 min-w-0 truncate text-sm font-bold text-zinc-700 dark:text-zinc-300">
                            {step.title || firstWordsOf(step.description) || t('recipeDetail.stepNumber', { number: idx + 1 })}
                          </span>
                          {step.durationMin ? (
                            <span className="shrink-0 text-xs font-semibold text-zinc-400 dark:text-zinc-500 tabular-nums">{t('recipeDetail.durationMinutes', { count: step.durationMin })}</span>
                          ) : null}
                          <span className="material-symbols-outlined text-[18px] text-zinc-300 dark:text-zinc-600 group-hover/row:text-primary">expand_more</span>
                        </button>
                      ) : (
                      <>
                      <div className="absolute top-3 right-3 flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => toggleStepCollapsed(idx)}
                          title={t('recipeDetail.collapseRow')}
                          className="w-8 h-8 rounded-full bg-white/80 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:text-zinc-700 dark:hover:text-zinc-200"
                        >
                          <span className="material-symbols-outlined text-sm">unfold_less</span>
                        </button>
                        <button
                          onClick={() => removeStep(idx)}
                          title={t('common.delete')}
                          className="w-8 h-8 rounded-full bg-red-50 text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-100"
                        >
                          <span className="material-symbols-outlined text-sm">delete</span>
                        </button>
                      </div>
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
                        ingredients={(draft.ingredients || []).map(ing => ({ ...ing, aliases: ingredientAliases(ing) }))}
                        tools={allTools.map(tool => ({ ...tool, name: tool.translated_name || tool.name, aliases: uniqueNames([tool.name, ...(tool.synonyms ?? [])]) }))}
                        units={allUnits}
                        techniques={allTechniques.map(tech => ({ id: tech.id, name: tech.translated_name || tech.name, aliases: uniqueNames([tech.name, ...(tech.synonyms ?? [])]) }))}
                        stepIngredients={step.stepIngredients || []}
                        allSteps={draft.steps || []}
                        stepIndex={idx}
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
                      <details className="mt-3">
                        <summary className="cursor-pointer text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 select-none">{t('recipeDetail.stepTranslationsOptional')}</summary>
                        <TranslationsEditor
                          translations={step.translations || []}
                          onChange={translations => updateStep(idx, 'translations', translations)}
                          titleLabel={t('recipeDetail.stepTitle')}
                          descriptionLabel={t('recipeDetail.stepDescription')}
                          notesLabel={t('recipeDetail.chefsNote')}
                          compact
                        />
                      </details>
                      <AutoTextarea
                        value={step.notes || ''}
                        onChange={e => updateStep(idx, 'notes', e.target.value)}
                        className="w-full mt-3 border border-dashed border-primary/20 bg-primary/5 rounded-xl p-3 text-xs italic resize-none focus:ring-2 focus:ring-primary/20 min-h-[60px] max-h-[40vh] overflow-y-auto"
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
                                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all ${
                                    isUsed ? 'bg-primary text-white border-primary' : 'bg-white dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 border-zinc-100 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600'
                                  }`}
                                >
                                  <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-base" />
                                  <span className="text-[11px] font-bold">{tool.translated_name || tool.name}</span>
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
                                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all ${
                                    isUsed ? 'bg-primary text-white border-primary' : 'bg-white dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 border-zinc-100 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600'
                                  }`}
                                >
                                  <RenderFaIcon name={tech.icon || 'TbFlame'} className="text-base" />
                                  <span className="text-[11px] font-bold">{tech.translated_name || tech.name}</span>
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
                        <details
                          className="mt-4 rounded-xl border border-zinc-100 dark:border-zinc-800 bg-white/60 dark:bg-zinc-900/60 px-3 py-2"
                          // Opened once on mount when the step already picks
                          // something, then left uncontrolled so toggling it
                          // stays a plain DOM interaction with no re-render.
                          ref={el => { if (el && !el.dataset.init) { el.dataset.init = '1'; el.open = (step.stepIngredients || []).length > 0; } }}
                        >
                          <summary className="cursor-pointer text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 select-none">
                            {t('recipeDetail.stepIngredientsSelected', { used: (step.stepIngredients || []).length, total: (draft.ingredients || []).length })}
                          </summary>
                          <div className="space-y-1.5 mt-2">
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
                                    {ing.ingredientName || ing.subRecipeTitle || t('recipeDetail.unnamedIngredient')}
                                    {ing.quantity ? ` (${formatEditorAmount(ing.quantity, ing.unitSymbol)} ${t('recipeDetail.totalLower')})` : ''}
                                    {/* What is still unspoken for by the time
                                        this step runs. A recipe that pours
                                        500 of its 620 g of flour into step 4
                                        has 120 g left for step 7, and working
                                        that out against every earlier step by
                                        hand is how the wrong number gets
                                        written down. */}
                                    {(() => {
                                      const left = remainingBeforeStep(draft.steps || [], idx, { sortOrder: ing.sortOrder, quantity: ing.quantity, unitSymbol: ing.unitSymbol });
                                      if (left === null || ing.quantity == null || left >= ing.quantity) return null;
                                      return (
                                        <span className="ml-1 font-bold text-amber-600 dark:text-amber-500">
                                          {t('recipeDetail.remainingHere', { amount: formatEditorAmount(left, ing.unitSymbol) })}
                                        </span>
                                      );
                                    })()}
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
                        </details>
                      )}
                      </>
                      )}
                    </div>
                  ))}
                </div>
                {/* Same reasoning as the ingredients list: you add the next
                    step from the bottom of the last one, not from a header
                    two screens up. */}
                <button
                  onClick={addStep}
                  className="mt-4 w-full flex items-center justify-center gap-1.5 px-4 py-3 rounded-2xl border-2 border-dashed border-primary/30 text-primary text-sm font-bold hover:bg-primary/5 hover:border-primary/50 transition-colors"
                >
                  <span className="material-symbols-outlined text-base">add</span> {t('recipeDetail.addStep')}
                </button>
                </>
                )}
              </div>
            </div>

            {/* Plain column, not a sticky scroll pane. Capping the rail at
                viewport height and giving it its OWN overflow-y put a second
                scrollbar on the edit screen next to the page's — two bars,
                and whichever one the wheel happened to be over is the one
                that moved. The rail is taller than the viewport anyway (cover,
                numbers, yield, tags, regions, tools, sources, translations),
                so pinning it only ever meant part of it was unreachable. */}
            <aside className="xl:col-span-4 space-y-6 min-w-0">
              {/* Cover image - metadata, so it belongs in the rail rather than
                  at the bottom of the text card. */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.coverImage')}</span>
                <ImageUrlInput
                  value={draft.cover_image_url || ''}
                  onChange={url => updateDraft('cover_image_url', url)}
                />
              </div>

              {/* Numbers - servings/times were four separate full-width tiles and
                  difficulty and the rating sat in a card whose left third was empty
                  below them. One card, 2x2. */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: t('recipeDetail.servings'), field: 'servings' },
                    { label: t('recipeDetail.prepMin'), field: 'prep_time_min' },
                    { label: t('recipeDetail.cookMin'), field: 'cook_time_min' },
                    { label: t('recipeDetail.restMin'), field: 'rest_time_min' },
                  ].map(f => (
                    <label key={f.field} className="bg-zinc-50 dark:bg-zinc-900 rounded-2xl px-4 py-3 border border-zinc-100 dark:border-zinc-800">
                      <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold block mb-1">{f.label}</span>
                      <input
                        type="number" value={String((draft as any)[f.field] || '')}
                        onChange={e => updateDraft(f.field, e.target.value ? parseInt(e.target.value) : null)}
                        className="w-full border-none bg-transparent text-xl font-bold text-zinc-800 dark:text-zinc-200 p-0 focus:ring-0"
                      />
                    </label>
                  ))}
                </div>
                <div className="flex items-end justify-between gap-4 mt-4">
                  <label className="min-w-0">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-1.5 block">{t('recipeDetail.difficulty')}</span>
                    <select
                      value={draft.difficulty || 'medium'}
                      onChange={e => updateDraft('difficulty', e.target.value)}
                      className="border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl px-3 py-2 font-medium text-sm focus:ring-2 focus:ring-primary/20"
                    >
                      {['easy','medium','hard','expert'].map(d => (
                        <option key={d} value={d}>{t(difficultyKey[d])}</option>
                      ))}
                    </select>
                  </label>
                  <label className="shrink-0">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-1.5 block">{t('recipeDetail.yourRating')}</span>
                    <StarRating value={draft.rating} onChange={rating => updateDraft('rating', rating)} />
                  </label>
                </div>
              </div>

              {/* Yield (optional — enables weight/volume amounts when this recipe is used as a sub-recipe ingredient) */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <h3 className="font-headline font-bold text-lg mb-2">{t('recipeDetail.yield')}</h3>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-4">{t('recipeDetail.yieldHint')}</p>
                <div className="flex gap-3">
                  <input
                    type="number" step="any" value={draft.yield_amount ?? ''}
                    onChange={e => updateDraft('yield_amount', e.target.value ? parseFloat(e.target.value) : null)}
                    placeholder={t('recipeDetail.yieldAmountPlaceholder')}
                    className="flex-1 min-w-0 border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary/20"
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

              {/* Tags */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <h3 className="font-headline font-bold text-lg mb-4">{t('recipeDetail.tags')}</h3>
                <TagPicker value={draft.tags || []} onChange={tags => updateDraft('tags', tags)} />
              </div>

              {/* Regions */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <h3 className="font-headline font-bold text-lg mb-2">{t('recipeDetail.regions')}</h3>
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

              {/* Kitchen tools - the picker used to render all of allTools (24 chips,
                  four rows, ~200px) just to show the one that was selected. What's
                  picked is on top now; the rest of the library is one click away. */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <h3 className="font-headline font-bold text-lg mb-4">{t('recipeDetail.kitchenTools')}</h3>
                <div className="flex flex-wrap gap-2">
                  {(draft.tools || []).map(tool => {
                    // A tool pasted through raw-text JSON isn't in the library yet and
                    // would fail to save as a real toolId - flagged amber so it can be
                    // reviewed before saving auto-creates it.
                    const known = allTools.some(at => at.id === tool.id);
                    return (
                      <button
                        key={tool.id}
                        onClick={() => toggleTool(tool)}
                        title={known ? undefined : t('recipeDetail.ingredientNeedsMatching')}
                        className={`flex items-center gap-2 px-3 py-2 rounded-xl border-2 transition-all ${
                          known
                            ? 'bg-primary/10 border-primary text-primary'
                            : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-base" />
                        <span className="text-xs font-bold">{tool.translated_name || tool.name}</span>
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    );
                  })}
                  {(draft.tools || []).length === 0 && (
                    <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('recipeDetail.noToolsSelected')}</p>
                  )}
                </div>
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs font-bold text-primary select-none">
                    {t('recipeDetail.addFromToolLibrary', { count: allTools.filter(at => !(draft.tools || []).some(dt => dt.id === at.id)).length })}
                  </summary>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {allTools.filter(at => !(draft.tools || []).some(dt => dt.id === at.id)).map(tool => (
                      <button
                        key={tool.id}
                        onClick={() => toggleTool(tool)}
                        className="flex items-center gap-2 px-3 py-2 rounded-xl border-2 bg-zinc-50 dark:bg-zinc-900 border-zinc-100 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600 transition-all"
                      >
                        <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-base" />
                        <span className="text-xs font-bold">{tool.translated_name || tool.name}</span>
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
                      className="flex-1 min-w-0 border-none bg-zinc-50 dark:bg-zinc-900 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/20"
                    />
                    <button
                      type="button"
                      onClick={createToolInline}
                      disabled={!newToolName.trim()}
                      className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-bold disabled:opacity-50 shrink-0"
                    >
                      {t('recipeDetail.addTool')}
                    </button>
                  </div>
                </details>
              </div>

              {/* Sources & References */}
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <h3 className="font-headline font-bold text-lg mb-4">{t('recipeDetail.sourcesReferences')}</h3>
                <RecipeSourcesEditor
                  sources={draft.sources || []}
                  onChange={sources => updateDraft('sources', sources)}
                />
              </div>

              {/* Translations */}
              <div id="translations-section" className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_2px_12px_rgba(0,0,0,0.04)] scroll-mt-24">
                <details>
                <summary className="cursor-pointer font-headline font-bold text-lg select-none">{t('recipeDetail.translations')}</summary>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2 mb-6">{t('recipeDetail.translationsHint')}</p>
                <TranslationsEditor
                  translations={draft.translations || []}
                  onChange={translations => updateDraft('translations', translations)}
                />
                <div className="mt-6 pt-6 border-t border-zinc-100 dark:border-zinc-800">
                  <span className="text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold mb-2 block">{t('recipeDetail.aiTranslate')}</span>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-3">{t('recipeDetail.aiTranslateHint')}</p>
                  <div className="flex items-center gap-3">
                    <select
                      value={aiTranslateLang}
                      onChange={e => setAiTranslateLang(e.target.value)}
                      className="border-none bg-zinc-50 dark:bg-zinc-900 rounded-xl px-4 py-3 font-medium text-sm focus:ring-2 focus:ring-primary/20"
                    >
                      {languages.filter(l => l.code !== 'en').map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
                    </select>
                    <button
                      type="button"
                      onClick={handleAiTranslate}
                      disabled={aiTranslating || !aiTranslateLang}
                      className="px-5 py-3 bg-primary text-white rounded-xl font-bold text-sm shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center gap-2"
                    >
                      {aiTranslating && <span className="material-symbols-outlined text-base animate-spin">sync</span>}
                      {aiTranslating ? t('recipeDetail.aiTranslating') : t('recipeDetail.aiTranslateButton')}
                    </button>
                  </div>
                  {aiTranslateError && <p className="mt-3 text-sm text-red-600 font-medium">{aiTranslateError}</p>}
                </div>
                </details>
              </div>
            </aside>
          </div>
        </main>
        )}
      </div>
    );
  }


  /* ═════════════════════════════════════════════════════════════════
     VIEW MODE (matches the screenshot design)
     ═════════════════════════════════════════════════════════════════ */
  const sortedIngredients = [...(recipe.ingredients || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  /* A substitute is not a line of its own in the list — it belongs under
     the ingredient it stands in for, as the alternative it is. Listed flat
     it reads as one more thing to buy, which is also exactly what the
     shopping list used to do with it (see matrioska.local.ts, which now
     drops these rows from the resolved totals). */
  const substitutesBySortOrder = new Map<number, Ingredient[]>();
  for (const ing of sortedIngredients) {
    if (ing.substituteFor == null) continue;
    const list = substitutesBySortOrder.get(ing.substituteFor);
    if (list) list.push(ing);
    else substitutesBySortOrder.set(ing.substituteFor, [ing]);
  }
  const primaryIngredients = sortedIngredients.filter(ing => ing.substituteFor == null);
  const sortedSteps = [...recipe.steps].sort((a, b) => a.stepNumber - b.stepNumber);

  const editButton = (inBar: boolean) => (
    <button
      onClick={() => setMode('edit')}
      className={inBar
        ? `${BAR_BUTTON} bg-primary text-white hover:bg-primary/90`
        : "flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors"}
      aria-label={t('recipeDetail.editRecipeAria')}
    >
      <span className="material-symbols-outlined text-[20px]">edit</span>
    </button>
  );

  const deleteButton = (inBar: boolean) => (
    <button
      onClick={handleDelete}
      disabled={saving}
      className={`${inBar ? BAR_BUTTON : ''} flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 hover:text-red-500 transition-colors disabled:opacity-50`}
      aria-label={t('recipeDetail.deleteRecipe')}
      title={t('recipeDetail.deleteRecipe')}
    >
      <span className="material-symbols-outlined text-[20px]">delete</span>
    </button>
  );

  const downloadButton = (inBar: boolean) => isNative() ? (
    <button
      onClick={handleToggleDownload}
      disabled={downloading}
      className={`${inBar ? BAR_BUTTON : ''} flex items-center gap-1.5 transition-colors disabled:opacity-50 ${downloaded ? 'text-primary' : 'text-zinc-500 dark:text-zinc-400 hover:text-primary'}`}
      aria-label={downloaded ? t('recipeDetail.removeOfflineDownload') : t('recipeDetail.downloadOffline')}
      title={downloaded ? t('recipeDetail.downloadedOffline') : t('recipeDetail.downloadOffline')}
    >
      <span className="material-symbols-outlined text-[20px]">
        {downloading ? 'sync' : downloaded ? 'download_done' : 'download'}
      </span>
    </button>
  ) : null;

  const shoppingListHeaderButton = (inBar: boolean) => (
    <button
      onClick={() => {
        addToShoppingCart({ recipeId: id!, title: recipe.translated_title || recipe.title, servings });
        setAddedToCart(true);
        setTimeout(() => setAddedToCart(false), 2000);
      }}
      className={`${inBar ? BAR_BUTTON : ''} flex items-center gap-1.5 transition-colors ${addedToCart ? 'text-primary' : 'text-zinc-500 dark:text-zinc-400 hover:text-primary'}`}
      aria-label={t('recipeDetail.addToShoppingList')}
      title={t('recipeDetail.addToShoppingList')}
    >
      <span className="material-symbols-outlined text-[20px]">{addedToCart ? 'check' : 'shopping_cart'}</span>
    </button>
  );

  const recipeSlug = (recipe.translated_title || recipe.title || 'recipe')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const downloadTextFile = (contents: string, filename: string, mime: string) => {
    const url = URL.createObjectURL(new Blob([contents], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportRecipe = async () => {
    setShowExportMenu(false);
    try {
      const res = await apiFetch(`/api/share/recipes/${id}/export`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ? JSON.stringify(json.error) : t('errors.exportFailed'));
      downloadTextFile(JSON.stringify(json.data, null, 2), `${recipeSlug}.smartchef.json`, 'application/json');
    } catch (err) {
      console.error('Recipe export failed:', err);
    }
  };

  /* ── Cookidoo (Bimby/Thermomix) export ─────────────────────────────────
     Built entirely from the already-loaded `recipe` rather than through
     /api/share: that route has no standalone-mode counterpart in
     localRouter.ts, and this export is text the user pastes by hand, so
     there's nothing a server round-trip would add. Works offline and in
     standalone mode as a result. */
  const handleExportForCookidoo = () => {
    setShowExportMenu(false);
    setCookidooExport(buildCookidooExport(recipe, {
      title: t('recipeDetail.cookidoo.fieldTitle'),
      prepTime: t('recipeDetail.cookidoo.fieldPrepTime'),
      totalTime: t('recipeDetail.cookidoo.fieldTotalTime'),
      servings: t('recipeDetail.cookidoo.fieldServings'),
      servingsValue: (n: number) => t('recipeDetail.cookidoo.portions', { count: n }),
      ingredients: t('recipeDetail.cookidoo.fieldIngredients'),
      steps: t('recipeDetail.cookidoo.fieldSteps'),
      devices: t('recipeDetail.cookidoo.fieldDevices'),
      tips: t('recipeDetail.cookidoo.fieldTips'),
      optional: t('recipeDetail.cookidoo.optional'),
      hourShort: t('recipeDetail.cookidoo.hourShort'),
      minuteShort: t('recipeDetail.cookidoo.minuteShort'),
      storagePrefix: t('recipeDetail.cookidoo.storagePrefix'),
      techniquesPrefix: t('recipeDetail.cookidoo.techniquesPrefix'),
    }, { servings }));
  };

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Electron/older webviews can reject the async clipboard API when the
      // document isn't focused; the legacy path still works there.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopiedSection(key);
    window.setTimeout(() => setCopiedSection(c => (c === key ? null : c)), 1500);
  };

  const exportHeaderButton = (inBar: boolean) => (
    <div className="relative">
      <button
        onClick={() => setShowExportMenu(v => !v)}
        className={`${inBar ? BAR_BUTTON : ''} flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 hover:text-primary transition-colors`}
        aria-label={t('recipeDetail.exportRecipe')}
        title={t('recipeDetail.exportRecipe')}
      >
        <span className="material-symbols-outlined text-[20px]">ios_share</span>
      </button>
      {showExportMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
          <div className={`${popoverPlacement(inBar)} bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-100 dark:border-zinc-800 p-2`} style={inBar ? POPOVER_ABOVE_BAR : undefined}>
            <button
              onClick={() => { setShowExportMenu(false); setShowShareLink(true); }}
              className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-[18px]">link</span>
              {t('share.menuItem')}
            </button>
            {/* Hidden rather than disabled on Android, where window.print()
                exists but silently does nothing — see lib/print.ts. */}
            {canPrint() && (
              <button
                onClick={() => { setShowExportMenu(false); printPage(recipe?.translated_title || recipe?.title); }}
                className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors flex items-center gap-2"
              >
                <span className="material-symbols-outlined text-[18px]">print</span>
                {t('print.printRecipe')}
              </button>
            )}
            <button
              onClick={handleExportRecipe}
              className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              {t('recipeDetail.exportAsJson')}
            </button>
            <button
              onClick={handleExportForCookidoo}
              className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              {t('recipeDetail.exportForCookidoo')}
            </button>
          </div>
        </>
      )}
    </div>
  );

  const cookidooModal = cookidooExport && (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50" onClick={() => setCookidooExport(null)}>
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl border border-zinc-100 dark:border-zinc-800"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 p-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('recipeDetail.cookidoo.title')}</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('recipeDetail.cookidoo.hint')}</p>
          </div>
          <button
            onClick={() => setCookidooExport(null)}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            aria-label={t('common.cancel')}
          >
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {cookidooExport.sections.map(section => (
            <div key={section.key}>
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <span className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">
                  {section.label}
                </span>
                <button
                  onClick={() => copyToClipboard(section.text, section.key)}
                  className="text-xs font-bold text-primary hover:opacity-70 transition-opacity"
                >
                  {copiedSection === section.key ? t('recipeDetail.cookidoo.copied') : t('recipeDetail.cookidoo.copy')}
                </button>
              </div>
              <pre className="whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-800/50 rounded-xl p-3 font-sans">
                {section.text}
              </pre>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-zinc-100 dark:border-zinc-800">
          <button
            onClick={() => downloadTextFile(cookidooExport.fullText, `${recipeSlug}.cookidoo.txt`, 'text/plain;charset=utf-8')}
            className="px-4 py-2.5 rounded-xl text-sm font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            {t('recipeDetail.cookidoo.download')}
          </button>
          <button
            onClick={() => copyToClipboard(cookidooExport.fullText, '__all__')}
            className="px-4 py-2.5 rounded-xl text-sm font-bold text-white bg-primary hover:opacity-90 transition-opacity"
          >
            {copiedSection === '__all__' ? t('recipeDetail.cookidoo.copied') : t('recipeDetail.cookidoo.copyAll')}
          </button>
        </div>
      </div>
    </div>
  );

  const collectionHeaderButton = (inBar: boolean) => (
    <div className="relative">
      <button
        onClick={() => showCollectionPicker ? setShowCollectionPicker(false) : openCollectionPicker()}
        className={`${inBar ? BAR_BUTTON : ''} flex items-center gap-1.5 transition-colors ${memberCollectionIds.size > 0 ? 'text-primary' : 'text-zinc-500 dark:text-zinc-400 hover:text-primary'}`}
        aria-label={t('recipeDetail.addToCollection')}
        title={t('recipeDetail.addToCollection')}
      >
        <span className="material-symbols-outlined text-[20px]">collections_bookmark</span>
      </button>
      {showCollectionPicker && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowCollectionPicker(false)} />
          <div className={`${popoverPlacement(inBar)} bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-100 dark:border-zinc-800 p-3`} style={inBar ? POPOVER_ABOVE_BAR : undefined}>
            <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest px-2 pb-2">{t('recipeDetail.addToCollection')}</p>
            {loadingCollections ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 px-2 py-2">{t('common.loading')}</p>
            ) : allCollections.length === 0 ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 px-2 py-2">{t('recipeDetail.noCollectionsYetCreateOne')}</p>
            ) : (
              <div className="max-h-56 overflow-y-auto space-y-0.5">
                {allCollections.map(c => (
                  <label key={c.id} className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={memberCollectionIds.has(c.id)}
                      onChange={() => toggleCollectionMembership(c.id)}
                      className="accent-primary w-4 h-4"
                    />
                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{c.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  // One set of actions, two homes: the top bar from `lg` up, a floating
  // bar at the bottom below it (see FloatingActionBar for why).
  const renderActions = (inBar: boolean) => (
    <>
      {downloadButton(inBar)}
      {shoppingListHeaderButton(inBar)}
      {collectionHeaderButton(inBar)}
      {exportHeaderButton(inBar)}
      {deleteButton(inBar)}
      {editButton(inBar)}
    </>
  );
  const headerActions = renderActions(false);

  return (
    <AppLayout headerActions={headerActions}>
      {cookidooModal}

      {/* ── Printed header ──────────────────────────────────────
          The hero below is white text laid over a photo, which prints as
          nothing at all once the background image is dropped. Paper gets its
          own title block instead: same information, black on white, with the
          cover kept small so it costs one band of ink rather than a third of
          the sheet. */}
      <div className="print-only max-w-7xl mx-auto px-6 pt-8">
        <div className="flex items-start gap-6 print-keep-together">
          {recipe.cover_image_url && (
            <CoverImage
              className="w-32 h-32 object-cover rounded-lg shrink-0 print-image"
              src={recipe.cover_image_url}
              alt={recipe.translated_title || recipe.title}
            />
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold leading-tight">{recipe.translated_title || recipe.title}</h1>
            {(recipe.translated_description || recipe.description) && (
              <p className="mt-1 text-sm">{recipe.translated_description || recipe.description}</p>
            )}
            <p className="mt-2 text-xs">
              {[
                recipe.creator_name ? `by ${recipe.creator_name}` : null,
                `${t('recipeDetail.servings')}: ${servings}`,
                totalTime ? `${t('recipeDetail.totalTime')}: ${formatTime(totalTime)}` : null,
              ].filter(Boolean).join('  ·  ')}
            </p>
            {recipe.source_url && (
              <p className="mt-1 text-xs">
                <a className="print-url" href={recipe.source_url}>{t('print.source')}</a>
              </p>
            )}
          </div>
        </div>
        <hr className="mt-4 mb-2 border-zinc-300" />
      </div>

      {/* ── Hero Image ─────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-6 pt-8 no-print">
        <div className="relative h-[360px] md:h-[400px] rounded-3xl overflow-hidden">
          <CoverImage
            className="w-full h-full object-cover"
            src={recipe.cover_image_url}
            alt={recipe.translated_title || recipe.title}
            fallbackSrc="https://images.unsplash.com/photo-1495521821757-a1efb6729352?q=80&w=2000"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
          <div className="absolute bottom-8 left-8 right-8">
            {((recipe.tags_display && recipe.tags_display.length > 0) || recipe.tags?.[0]) && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {recipe.tags_display && recipe.tags_display.length > 0 ? (
                  <>
                    {recipe.tags_display.slice(0, 3).map((tag, i) => (
                      <span
                        key={i}
                        className="inline-block px-3 py-1 text-white text-[10px] font-bold uppercase tracking-[0.15em] rounded-full"
                        style={{ backgroundColor: tag.color || '#3f3f46' }}
                      >
                        {tag.translated_name}
                      </span>
                    ))}
                    {recipe.tags_display.length > 3 && (
                      <span className="inline-block px-3 py-1 bg-black/40 text-white text-[10px] font-bold uppercase tracking-[0.15em] rounded-full">
                        +{recipe.tags_display.length - 3}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="inline-block px-3 py-1 bg-primary text-white text-[10px] font-bold uppercase tracking-[0.15em] rounded-full">
                    {recipe.tags[0]}
                  </span>
                )}
              </div>
            )}
            <h1 className="text-4xl md:text-6xl font-headline font-extrabold text-white leading-none">{recipe.translated_title || recipe.title}</h1>
            {(recipe.translated_description || recipe.description) && (
              <p className="mt-3 text-white/80 text-sm font-medium max-w-2xl leading-relaxed">
                {recipe.translated_description || recipe.description}
              </p>
            )}
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
            <label className="mt-3 inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-black/40 backdrop-blur-sm text-white text-xs font-bold">
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">translate</span>
              <select
                value={shownLang}
                onChange={(e) => setViewLang(e.target.value)}
                aria-label={t('recipeDetail.viewLanguage')}
                className="bg-transparent text-white text-xs font-bold border-0 py-0 pl-0 pr-6 focus:ring-0 focus-visible:underline cursor-pointer max-w-[12rem]"
              >
                {[...languages, ...(languages.some((l) => l.code === shownLang) ? [] : [{ code: shownLang, label: languageLabel(shownLang) }])].map((l) => (
                  <option key={l.code} value={l.code} className="text-zinc-900">
                    {l.label}{l.code === recipe.language_code ? ` · ${t('recipeDetail.originalLanguage')}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {recipe.language_code && shownLang && recipe.language_code !== shownLang && !recipe.translated_title && (
              <p className="mt-2 text-white/70 text-xs font-medium">
                {t('recipeDetail.shownInOriginal', {
                  shownLang: languageLabel(recipe.language_code),
                  targetLang: languageLabel(shownLang),
                })}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Stats Bar ──────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-6 mt-8">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {[
            { label: t('recipeDetail.prepTime'), val: formatTime(recipe.prep_time_min), icon: 'schedule' },
            { label: t('recipeDetail.waitingTime'), val: formatTime(recipe.rest_time_min), icon: 'hourglass_empty' },
            { label: t('recipeDetail.cookTime'), val: formatTime(recipe.cook_time_min), icon: 'oven_gen' },
            { label: t('recipeDetail.totalTime'), val: formatTime(totalTime), icon: 'local_fire_department' },
            { label: t('recipeDetail.complexity'), val: difficultyKey[recipe.difficulty] ? t(difficultyKey[recipe.difficulty]) : recipe.difficulty, icon: 'restaurant', highlight: true },
          ].map((stat, i) => (
            <div key={i} className={`py-4 px-4 rounded-2xl flex flex-col items-center text-center ${stat.highlight ? 'bg-primary/8 border border-primary/15' : 'bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800'}`}>
              <span className={`material-symbols-outlined mb-1.5 ${stat.highlight ? 'text-primary' : 'text-primary/60'}`} style={{ fontVariationSettings: "'FILL' 1" }}>{stat.icon}</span>
              <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 dark:text-zinc-500 font-bold">{stat.label}</p>
              <p className={`text-lg font-bold font-headline ${stat.highlight ? 'text-primary' : 'text-zinc-800 dark:text-zinc-200'}`}>{stat.val}</p>
            </div>
          ))}
        </div>
        {/* One action bar, not three stacked ones: the rating, the cook log
            and the timestamps each had their own full-width band, spending
            ~190px of vertical space on a star row and a counter. */}
        <div className="mt-4 py-3 px-6 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center flex-wrap gap-x-5 gap-y-3 no-print">
            <div className="flex items-center gap-3">
              <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 dark:text-zinc-500 font-bold">{t('recipeDetail.yourRating')}</p>
              <StarRating value={recipe.rating} onChange={handleRate} />
            </div>
            <div className="hidden lg:block w-px h-6 bg-zinc-100 dark:bg-zinc-800" />
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary/60" style={{ fontVariationSettings: "'FILL' 1" }}>skillet</span>
              <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 dark:text-zinc-500 font-bold">
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
            <Link
              to="/history"
              className="flex items-center gap-1.5 px-4 py-2 rounded-full text-zinc-400 dark:text-zinc-500 text-xs font-bold hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-base">event_available</span>
              {t('history.viewHistory')}
            </Link>
            <div className="flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 font-medium lg:ml-auto">
              <span>{t('recipeDetail.created', { date: formatDate(recipe.created_at) })}</span>
              <span>&middot;</span>
              <span>{t('recipeDetail.lastEdited', { date: formatDate(recipe.updated_at) })}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Where it comes from ────────────────────────────────
          Squeezed into a third of the bottom band, the map was ~290px of
          a world it was trying to show a country on. It is also the first
          thing anyone asks about a dish, so it reads better before the
          method than after it: full width, above the fold-ish, under the
          rating bar and ahead of the servings/ingredients/steps columns. */}
      {recipe.regions && recipe.regions.length > 0 && (
        <div className="max-w-7xl mx-auto px-6 mt-6">
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
              <h3 className="font-headline font-bold text-lg">{t('recipeDetail.regions')}</h3>
              <div className="flex flex-wrap gap-1.5">
                {recipe.regions.map((r) => (
                  <span key={r} className="px-3 py-1.5 rounded-full text-xs font-bold bg-zinc-50 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                    {isCountryCode(r) ? `${flagEmoji(r)} ${countryDisplayName(r, i18n.language)}` : r}
                  </span>
                ))}
              </div>
            </div>
            {isOnline && <RegionsMap regions={recipe.regions} coords={recipe.region_coords || {}} />}
          </div>
        </div>
      )}

      <ConverterPanel open={showConverter} onClose={() => setShowConverter(false)} />
      {id && (
        <ShareLinkModal
          open={showShareLink}
          onClose={() => setShowShareLink(false)}
          recipeId={id}
          standalone={isStandalone}
          onExportFile={handleExportRecipe}
        />
      )}

      {/* ── Two-column layout ──────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-6 mt-10 pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 print:block">

          {/* Left column: Servings + Ingredients + Equipment */}
          <div className="lg:col-span-5 space-y-8">
            {/* Servings card — a slider, so screen-only. The printed header
                already states the servings the quantities below are scaled to. */}
            <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 no-print">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-headline font-bold text-lg">{t('recipeDetail.servings')}</h3>
                <span className="text-3xl font-extrabold text-primary font-headline">{servings}</span>
              </div>
              <input
                type="range" min="1" max="12"
                value={servings}
                onChange={(e) => setServings(parseInt(e.target.value))}
                className="w-full h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full appearance-none cursor-pointer accent-primary"
              />
              <div className="flex justify-between mt-2 text-[10px] text-zinc-400 dark:text-zinc-500 font-bold uppercase tracking-wider">
                <span>{t('recipeDetail.onePortion')}</span><span>{t('recipeDetail.twelvePortions')}</span>
              </div>

              {/* How much this makes in total, tracking the slider. The
                  recipe stores its yield at its OWN base servings, so it has
                  to scale like every ingredient amount does — and it goes
                  through formatAmount() rather than being printed raw, so it
                  also restates in the chosen measurement system (a 500 g
                  yield reads in ounces for someone on imperial) instead of
                  being the one number on the page that ignores that setting.
                  Hidden entirely when the recipe has no yield on file, which
                  is most of them: it is an optional field. */}
              {recipe.yield_amount != null && (
                <div className="flex items-baseline justify-between gap-3 mt-4 pt-3 border-t border-zinc-100 dark:border-zinc-800">
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-bold uppercase tracking-wider">
                    {t('recipeDetail.yield')}
                  </span>
                  <span className="text-sm font-bold text-zinc-700 dark:text-zinc-300 tabular-nums">
                    {formatAmount(
                      recipe.yield_amount,
                      allUnits.find((u) => u.id === recipe.yield_unit_id)?.symbol ?? null
                    )}
                    {/* A yield with no unit on file renders as a bare number
                        ("315"), which says nothing — 315 grams, millilitres,
                        biscuits? The unit is an optional column and plenty of
                        rows were saved without it, so rather than hiding the
                        problem this offers the one-click way to fix it: the
                        edit form's yield row already has the unit picker. */}
                    {!recipe.yield_unit_id && (
                      <button
                        type="button"
                        onClick={() => setMode('edit')}
                        className="ml-2 text-[10px] font-bold uppercase tracking-wider text-primary hover:underline align-middle"
                      >
                        + {t('recipeDetail.unit')}
                      </button>
                    )}
                  </span>
                </div>
              )}

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
            <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center justify-between gap-3 mb-5">
                <h3 className="font-headline font-bold text-lg">{t('recipeDetail.ingredients')}</h3>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Display only — the recipe keeps what its author wrote. */}
                  <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
                    {(['metric', 'imperial'] as const).map((sys) => (
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
                  <button
                    type="button"
                    onClick={() => setShowConverter(true)}
                    title={t('converter.title')}
                    aria-label={t('converter.title')}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-primary transition-colors"
                  >
                    <span className="material-symbols-outlined text-[19px]">swap_horiz</span>
                  </button>
                </div>
              </div>
              <div className="space-y-1">
                {primaryIngredients.map((ing, idx) => {
                  const prevGroupName = idx > 0 ? primaryIngredients[idx - 1].groupName : null;
                  const showGroupHeader = !!ing.groupName && ing.groupName !== prevGroupName;
                  const substitutes = substitutesBySortOrder.get(ing.sortOrder) ?? [];
                  return (
                  <div key={idx}>
                    {showGroupHeader && (
                      <p className="px-3 pt-4 pb-1 text-xs uppercase tracking-wider text-zinc-400 dark:text-zinc-500 font-bold first:pt-0">
                        {ing.groupName}
                      </p>
                    )}
                    <div className={`flex items-center justify-between py-3 px-3 rounded-xl transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900 ${ing.subRecipeId ? 'bg-zinc-50/60 dark:bg-zinc-900/60' : ''}`}>
                      <div className="flex items-center gap-2">
                        {ing.subRecipeId && (
                          <span className="material-symbols-outlined text-primary text-[18px]">package_2</span>
                        )}
                        <span className={`text-sm ${ing.subRecipeId ? 'font-bold text-zinc-800 dark:text-zinc-200' : 'text-zinc-700 dark:text-zinc-300'}`}>
                          {ing.ingredientName ? pickIngredientName(ing.ingredientName, ing.ingredientPluralName, scaleNum(ing.quantity)) : ing.subRecipeTitle}
                        </span>
                        {/* Said out loud rather than left to the cook to
                            infer from a note: this is also the flag the
                            pantry matcher discounts, so someone wondering
                            why a recipe came up "ready to cook" without
                            the garnish can see why. */}
                        {ing.isOptional && (
                          <span className="shrink-0 rounded-full bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-700 dark:text-amber-500">
                            {t('recipeDetail.optional')}
                          </span>
                        )}
                      </div>
                      <span className="text-sm text-zinc-500 dark:text-zinc-400 font-semibold tabular-nums">
                        {formatAmount(ing.quantity, ing.unitSymbol, ing.quantityText)}
                      </span>
                    </div>
                    {tidyNote(ing.translatedNotes || ing.notes) && (
                      <p className="px-3 pb-2 text-[11px] text-zinc-400 dark:text-zinc-500 font-medium italic">— {tidyNote(ing.translatedNotes || ing.notes)}</p>
                    )}
                    {substitutes.map((alt, altIdx) => (
                      <div key={`alt-${altIdx}`} className="flex items-center justify-between gap-3 py-2 pl-8 pr-3 -mt-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="shrink-0 text-[9px] font-black uppercase tracking-wider text-sky-600 dark:text-sky-500">{t('recipeDetail.orInstead')}</span>
                          <span className="text-sm text-zinc-600 dark:text-zinc-400 truncate">
                            {alt.ingredientName ? pickIngredientName(alt.ingredientName, alt.ingredientPluralName, scaleNum(alt.quantity)) : alt.subRecipeTitle}
                          </span>
                        </div>
                        <span className="text-sm text-zinc-400 dark:text-zinc-500 font-semibold tabular-nums shrink-0">
                          {formatAmount(alt.quantity, alt.unitSymbol, alt.quantityText)}
                        </span>
                      </div>
                    ))}
                    {ing.subRecipeId && (
                      <SubIngredientList
                        subRecipeId={ing.subRecipeId}
                        servings={servings}
                        baseServings={recipe.servings}
                      />
                    )}
                  </div>
                  );
                })}
              </div>
            </div>

            {/* Equipment card - tools and techniques share one card. As two
                separate cards they read as a pair of near-empty chip boxes
                stacked on each other; together they are one sidebar block. */}
            {((recipe.tools && recipe.tools.length > 0) || (recipe.techniques && recipe.techniques.length > 0)) && (
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
                <h3 className="font-headline font-bold text-lg mb-5">{t('recipeDetail.equipment')}</h3>
                {recipe.tools && recipe.tools.length > 0 && (
                  <>
                    <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-400 dark:text-zinc-500 font-bold mb-2.5">{t('recipeDetail.kitchenTools')}</p>
                    <div className="flex flex-wrap gap-2">
                      {recipe.tools.map(tool => (
                        <div key={tool.id} className="flex items-center gap-2 px-3 py-2 bg-zinc-50 dark:bg-zinc-900 rounded-xl border border-zinc-100 dark:border-zinc-800">
                          <RenderFaIcon name={tool.icon || 'TbToolsKitchen'} className="text-primary text-lg" />
                          <span className="text-xs font-bold text-zinc-600 dark:text-zinc-400">{tool.translated_name || tool.name}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {recipe.techniques && recipe.techniques.length > 0 && (
                  <>
                    <p className={`text-[10px] uppercase tracking-[0.15em] text-zinc-400 dark:text-zinc-500 font-bold mb-2.5 ${recipe.tools && recipe.tools.length > 0 ? 'mt-5' : ''}`}>{t('recipeDetail.techniques')}</p>
                    <div className="flex flex-wrap gap-2">
                      {recipe.techniques.map(tech => (
                        <div key={tech.id} className="flex items-center gap-2 px-3 py-2 bg-zinc-50 dark:bg-zinc-900 rounded-xl border border-zinc-100 dark:border-zinc-800">
                          <RenderFaIcon name={tech.icon || 'TbFlame'} className="text-primary text-lg" />
                          <span className="text-xs font-bold text-zinc-600 dark:text-zinc-400">{tech.translated_name || tech.name}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>


          {/* Right column: Method + Kitchen Mode button */}
          <div className="lg:col-span-7">
            <div className="flex items-center justify-between mb-8">
              <h2 className="font-headline font-extrabold text-3xl text-zinc-900 dark:text-zinc-100">{t('recipeDetail.theMethod')}</h2>
              <button
                onClick={startCooking}
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
                      <div className="w-0.5 flex-1 bg-zinc-200 dark:bg-zinc-700 mt-3" />
                    )}
                  </div>

                  {/* Step content */}
                  <div className="flex-1 pb-6">
                    <h4 className="font-headline font-bold text-xl text-zinc-800 dark:text-zinc-200 mb-3">
                      {step.translatedTitle || step.title || t('recipeDetail.stepNumber', { number: step.stepNumber })}
                    </h4>
                    <div className="bg-white dark:bg-zinc-900 p-6 rounded-2xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 group-hover:border-primary/15 transition-colors">
                      <ResolvedImage src={step.imageUrl} className="w-full max-h-64 object-cover rounded-xl mb-4" />
                      <p className="text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400 mb-4">
                        <RenderStepText text={step.translatedDescription || step.description} ingredients={stepTextIngredientsFor(step)} tools={stepTextTools} techniques={stepTextTechniques} />
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
                        <div className="flex items-center gap-2 text-sm text-zinc-400 dark:text-zinc-500 mb-4">
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

        {/* Details band - storage and nutrition. These used to sit at the
            bottom of the sidebar, which made that column run roughly twice
            as long as the method beside it: every recipe left the whole
            right half of the page empty below its last step. Origin moved
            up above the method (it wants a real map, not a third of a
            column), and tips/references moved down into their own row. */}
        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          {/* Storage card */}
          {recipe.storage_instructions && (
            <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
              <h3 className="font-headline font-bold text-lg mb-5">{t('recipeDetail.storageInstructions')}</h3>
              <p className="text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">{recipe.storage_instructions}</p>
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
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
                <h3 className="font-headline font-bold text-lg mb-1">{t('recipeDetail.nutrition')}</h3>
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mb-4">{t('recipeDetail.totalForServings', { count: servings })}</p>
                <div className="grid grid-cols-2 gap-2">
                  {fields.map(f => (
                    <div key={f.key} className="flex items-center justify-between px-3 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-900">
                      <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{f.label}</span>
                      <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200 tabular-nums">
                        {Math.round(at[f.key])} {f.unit}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-3">
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

        {/* The last word on a recipe — what the cook should know before
            starting, and where it came from. One row of two halves, full
            width: these are the two blocks people read end to end, and in
            the three-column band above they were a narrow ribbon of text
            next to a nutrition table. */}
        {(recipe.tips || (recipe.sources && recipe.sources.length > 0)) && (
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
            {recipe.tips && (
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
                <h3 className="font-headline font-bold text-lg mb-5">{t('recipeDetail.tips')}</h3>
                <p className="text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">{recipe.tips}</p>
              </div>
            )}
            {recipe.sources && recipe.sources.length > 0 && (
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800">
                <h3 className="font-headline font-bold text-lg mb-5">{t('recipeDetail.references')}</h3>
                <div className="space-y-2">
                  {recipe.sources.map((source, idx) => {
                    const meta = SOURCE_TYPE_META[source.type] || SOURCE_TYPE_META.other;
                    const content = (
                      <div className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors">
                        <span className="material-symbols-outlined text-primary text-lg shrink-0">{meta.icon}</span>
                        <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 truncate">{source.label || source.url}</span>
                      </div>
                    );
                    return source.url ? (
                      <a key={idx} href={source.url} target="_blank" rel="noopener noreferrer">{content}</a>
                    ) : (
                      <div key={idx}>{content}</div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Room for the floating action bar below, so the last section can be
          scrolled clear of it instead of ending up underneath. */}
      <div className="lg:hidden no-print" style={{ height: FLOATING_ACTION_BAR_CLEARANCE }} aria-hidden="true" />
      <FloatingActionBar label={t('recipeDetail.actionsLabel')}>{renderActions(true)}</FloatingActionBar>
    </AppLayout>
  );
};

export default RecipeDetail;