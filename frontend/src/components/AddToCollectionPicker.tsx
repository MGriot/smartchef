import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '../lib/api';
import { MEAL_TYPES, menuKind, type MealType, type MenuCourse, type MenuSummary } from './planner/types';

/** Monday-first weekday names in the app's language — 2024-01-01 was a Monday. */
function weekDayLabels(lang: string): string[] {
  const fmt = new Intl.DateTimeFormat(lang, { weekday: 'long' });
  return Array.from({ length: 7 }, (_, i) => {
    const name = fmt.format(new Date(2024, 0, 1 + i));
    return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
  });
}

const FIELD = 'w-full text-xs font-semibold bg-zinc-50 dark:bg-zinc-800 rounded-lg px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200';

/** Where a recipe can be filed: a collection, or a planner menu — a weekly
 *  plan (pick the day) or an event menu (pick the course). Shared by the
 *  recipe page's popover and each gallery card's menu. */
export default function AddToCollectionPicker({
  recipeId,
  servings = 4,
  onMembershipChange,
}: {
  recipeId: string;
  servings?: number;
  /** Told whether the recipe is now in at least one collection. */
  onMembershipChange?: (inAny: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [collections, setCollections] = useState<Array<{ id: string; name: string }>>([]);
  const [member, setMember] = useState<Set<string>>(new Set());
  const [menus, setMenus] = useState<MenuSummary[]>([]);

  const [menuId, setMenuId] = useState('');
  const [courses, setCourses] = useState<MenuCourse[]>([]);
  const [day, setDay] = useState(0);
  const [courseId, setCourseId] = useState('');
  const [mealType, setMealType] = useState<MealType>('dinner');
  const [count, setCount] = useState(servings);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<'added' | 'failed' | null>(null);

  const days = useMemo(() => weekDayLabels(i18n.language), [i18n.language]);
  const selectedMenu = menus.find((m) => m.id === menuId);
  const kind = menuKind(selectedMenu);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [allRes, memberRes, menusRes] = await Promise.all([
          apiFetch('/api/collections'),
          apiFetch(`/api/recipes/${recipeId}/collections`),
          apiFetch('/api/menus'),
        ]);
        const all = await allRes.json();
        const mem = await memberRes.json();
        const mn = await menusRes.json();
        if (cancelled) return;
        setCollections((all.data || []).map((c: any) => ({ id: c.id, name: c.name })));
        setMember(new Set((mem.data || []).map((c: any) => c.id)));
        const list: MenuSummary[] = Array.isArray(mn.data) ? mn.data : [];
        setMenus(list);
        if (list.length > 0) setMenuId(list[0].id);
      } catch (err) {
        console.error('Failed to load collections/menus:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [recipeId]);

  // An event menu's courses live on its detail, not its list row.
  useEffect(() => {
    setStatus(null);
    if (!menuId || kind !== 'event') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/menus/${menuId}`);
        const json = await res.json();
        if (cancelled) return;
        const list: MenuCourse[] = Array.isArray(json.data?.courses) ? json.data.courses : [];
        setCourses(list);
        setCourseId(list[0]?.id ?? '');
        setMealType(list[0]?.mealType ?? json.data?.meal_type ?? 'dinner');
        if (json.data?.guests) setCount(json.data.guests);
      } catch (err) {
        console.error('Failed to load menu courses:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [menuId, kind]);

  const toggle = async (collectionId: string) => {
    const isMember = member.has(collectionId);
    const next = new Set(member);
    if (isMember) next.delete(collectionId); else next.add(collectionId);
    setMember(next);
    onMembershipChange?.(next.size > 0);
    if (isMember) {
      await apiFetch(`/api/collections/${collectionId}/recipes/${recipeId}`, { method: 'DELETE' });
    } else {
      await apiFetch(`/api/collections/${collectionId}/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId }),
      });
    }
  };

  const addToMenu = async () => {
    if (!menuId || adding) return;
    if (kind === 'event' && !courseId) return;
    setAdding(true);
    setStatus(null);
    try {
      const body = kind === 'event'
        ? { recipeId, courseId, servings: count, mealType }
        : { recipeId, dayOfWeek: day, mealType, servings: count };
      const res = await apiFetch(`/api/menus/${menuId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setStatus(res.ok ? 'added' : 'failed');
    } catch {
      setStatus('failed');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest px-2 pb-2">{t('recipeDetail.addToCollection')}</p>
      {loading ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 px-2 py-2">{t('common.loading')}</p>
      ) : (
        <>
          {collections.length === 0 ? (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 px-2 py-2">{t('recipeDetail.noCollectionsYetCreateOne')}</p>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-0.5">
              {collections.map((c) => (
                <label key={c.id} className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer">
                  <input type="checkbox" checked={member.has(c.id)} onChange={() => toggle(c.id)} className="accent-primary w-4 h-4" />
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{c.name}</span>
                </label>
              ))}
            </div>
          )}

          <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest px-2 pt-3 pb-2 border-t border-zinc-100 dark:border-zinc-800 mt-2">
            {t('recipeDetail.addToMenu')}
          </p>
          {menus.length === 0 ? (
            <p className="text-xs text-zinc-400 dark:text-zinc-500 px-2 py-1">{t('recipeDetail.noMenusYet')}</p>
          ) : (
            <div className="px-1 space-y-2">
              <select value={menuId} onChange={(e) => setMenuId(e.target.value)} className={FIELD} aria-label={t('recipeDetail.addToMenu')}>
                {menus.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <div className="flex gap-2">
                {kind === 'event' ? (
                  <select
                    value={courseId}
                    onChange={(e) => {
                      setCourseId(e.target.value);
                      // A day menu's course belongs to one meal.
                      const meal = courses.find((c) => c.id === e.target.value)?.mealType;
                      if (meal) setMealType(meal);
                    }}
                    className={FIELD}
                    aria-label={t('planner.event.course')}
                  >
                    {courses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.mealType ? `${t(`planner.mealTypes.${c.mealType}`)} · ${c.name}` : c.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <select value={day} onChange={(e) => setDay(Number(e.target.value))} className={FIELD}>
                    {days.map((label, i) => <option key={i} value={i}>{label}</option>)}
                  </select>
                )}
                {/* An event menu's meal is fixed by the menu and its course
                    (shown in the course list); only a weekly plan asks. */}
                {kind === 'week' && (
                  <select value={mealType} onChange={(e) => setMealType(e.target.value as MealType)} className={FIELD}>
                    {MEAL_TYPES.map((mt) => <option key={mt} value={mt}>{t(`planner.mealTypes.${mt}`)}</option>)}
                  </select>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
                  className={`${FIELD} !w-16`}
                  aria-label={t('planner.servings')}
                />
                <button
                  type="button"
                  onClick={addToMenu}
                  disabled={adding || (kind === 'event' && !courseId)}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-bold disabled:opacity-50"
                >
                  {t('common.add')}
                </button>
              </div>
              {status === 'added' && <p className="text-xs font-semibold text-primary px-1">{t('recipeDetail.addedToMenu')}</p>}
              {status === 'failed' && <p className="text-xs font-semibold text-red-600 px-1">{t('recipeDetail.addToMenuFailed')}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
