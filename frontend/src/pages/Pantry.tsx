import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AppLayout from '../components/AppLayout';
import Autocomplete from '../components/Autocomplete';
import RenderFaIcon from '../components/RenderFaIcon';
import { ResolvedImage } from '../components/CoverImage';
import { Field } from '../components/Form';
import { useStore } from '../store/app.store';
import { apiFetch } from '../lib/api';

interface PantryRow {
  id: string;
  ingredient_id: string;
  ingredient_name: string | null;
  category_name: string | null;
  category_color: string | null;
  quantity: number | null;
  unit_id: string | null;
  unit_symbol: string | null;
  expires_at: string | null;
}

interface Cookable {
  recipeId: string;
  title: string;
  coverImageUrl: string | null;
  matchRatio: number;
  have: number;
  required: number;
  missing: Array<{ ingredientId: string; name: string; quantity: number; unitSymbol: string }>;
}

/** What is in the house, and what it lets you cook.
 *
 *  The "what can I cook" half posts the pantry to
 *  POST /recipes/filter-by-pantry — the endpoint whose request contract was
 *  frozen for exactly this long before there was anything to call it. */
export default function Pantry() {
  const { t } = useTranslation();
  const contentLang = useStore((s) => s.contentLang);

  const [items, setItems] = useState<PantryRow[] | null>(null);
  const [allIngredients, setAllIngredients] = useState<Array<{ id: string; name: string; translated_name?: string | null }>>([]);
  const [units, setUnits] = useState<Array<{ id: string; symbol: string; name: string }>>([]);

  const [newIngredientId, setNewIngredientId] = useState('');
  const [newQuantity, setNewQuantity] = useState('');
  const [newUnitId, setNewUnitId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cookable, setCookable] = useState<Cookable[] | null>(null);
  const [checking, setChecking] = useState(false);
  // 1 = only recipes you can cook outright. Lower it to see near misses.
  const [threshold, setThreshold] = useState(1);

  const langQuery = contentLang ? `?lang=${contentLang}` : '';

  const load = async () => {
    try {
      const [pantryRes, ingRes, unitRes] = await Promise.all([
        apiFetch('/api/pantry'),
        apiFetch(`/api/ingredients${langQuery}`),
        apiFetch('/api/units'),
      ]);
      setItems((await pantryRes.json()).data ?? []);
      setAllIngredients((await ingRes.json()).data ?? []);
      setUnits((await unitRes.json()).data ?? []);
    } catch (err) {
      console.error('Pantry load failed:', err);
      setItems([]);
    }
  };

  useEffect(() => { void load(); }, [contentLang]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIngredientId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/pantry', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ingredientId: newIngredientId,
          // Blank means "I have some" — the matcher treats that as enough,
          // and demanding a weight is what stops anyone keeping a pantry.
          quantity: newQuantity.trim() ? Number(newQuantity.replace(',', '.')) : null,
          unitId: newUnitId || null,
        }),
      });
      if (!res.ok) throw new Error(t('pantry.saveFailed'));
      setNewIngredientId('');
      setNewQuantity('');
      setNewUnitId('');
      setCookable(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pantry.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setItems((prev) => prev?.filter((i) => i.id !== id) ?? prev);
    setCookable(null);
    try {
      await apiFetch(`/api/pantry/${id}`, { method: 'DELETE' });
    } catch {
      void load();
    }
  };

  const check = async (ratio = threshold) => {
    if (!items?.length) return;
    setChecking(true);
    setError(null);
    try {
      const res = await apiFetch('/api/recipes/filter-by-pantry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ingredients: items.map((i) => ({
            ingredientId: i.ingredient_id,
            ...(i.quantity != null ? { quantity: i.quantity } : {}),
            ...(i.unit_symbol ? { unit: i.unit_symbol } : {}),
          })),
          minMatchRatio: ratio,
        }),
        timeoutMs: 60_000,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('pantry.checkFailed'));
      setCookable(json.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pantry.checkFailed'));
    } finally {
      setChecking(false);
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null; rows: PantryRow[] }>();
    for (const row of items ?? []) {
      const key = row.category_name ?? '__other__';
      if (!map.has(key)) map.set(key, { name: row.category_name ?? t('pantry.other'), color: row.category_color, rows: [] });
      map.get(key)!.rows.push(row);
    }
    return [...map.values()];
  }, [items, t]);

  const ingredientOptions = allIngredients.map((i) => ({ id: i.id, label: i.translated_name || i.name }));

  return (
    <AppLayout>
      <div className="px-6 sm:px-10 py-10 max-w-6xl mx-auto">
        <div className="mb-10">
          <p className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase mb-2">{t('pantry.eyebrow')}</p>
          <h1 className="text-5xl font-black text-zinc-900 dark:text-zinc-100 tracking-tight leading-none">{t('pantry.title')}</h1>
          <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-3 max-w-2xl">{t('pantry.intro')}</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* ── What's in the house ── */}
          <div className="lg:col-span-6 space-y-6">
            <form onSubmit={add} className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 space-y-4">
              <h2 className="font-headline font-bold text-lg">{t('pantry.addTitle')}</h2>
              <Field label={t('pantry.ingredient')}>
                <Autocomplete
                  value={newIngredientId}
                  options={ingredientOptions}
                  onSelect={(id) => setNewIngredientId(id)}
                  onClear={() => setNewIngredientId('')}
                  placeholder={t('pantry.searchIngredient')}
                  className="sc-field"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('pantry.quantityOptional')} hint={t('pantry.quantityHint')}>
                  <input
                    type="number" step="any" min="0" value={newQuantity}
                    onChange={(e) => setNewQuantity(e.target.value)}
                    className="sc-field"
                  />
                </Field>
                <Field label={t('pantry.unit')}>
                  <select value={newUnitId} onChange={(e) => setNewUnitId(e.target.value)} className="sc-field cursor-pointer">
                    <option value="">—</option>
                    {units.map((u) => <option key={u.id} value={u.id}>{u.symbol}</option>)}
                  </select>
                </Field>
              </div>
              <button
                type="submit"
                disabled={saving || !newIngredientId}
                className="w-full py-3.5 rounded-2xl bg-primary text-white font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-50"
              >
                {saving ? t('pantry.adding') : t('pantry.add')}
              </button>
            </form>

            {items === null ? (
              <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('common.loading')}</p>
            ) : items.length === 0 ? (
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-10 text-center border border-zinc-100 dark:border-zinc-800">
                <span className="material-symbols-outlined text-4xl text-zinc-300 dark:text-zinc-600">kitchen</span>
                <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium mt-3">{t('pantry.empty')}</p>
              </div>
            ) : (
              grouped.map((group) => (
                <div key={group.name} className="bg-white dark:bg-zinc-900 rounded-3xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 overflow-hidden">
                  <div className="flex items-center gap-2.5 px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/40">
                    <span className="w-5 h-5 rounded-md shrink-0" style={{ backgroundColor: group.color || '#71717a' }} />
                    <h3 className="text-[11px] font-black uppercase tracking-widest text-zinc-500 dark:text-zinc-400">{group.name}</h3>
                  </div>
                  <div className="px-6 divide-y divide-zinc-50 dark:divide-zinc-800">
                    {group.rows.map((row) => (
                      <div key={row.id} className="flex items-center gap-3 py-3">
                        <span className="flex-1 min-w-0 text-sm font-bold text-zinc-800 dark:text-zinc-200 truncate">
                          {row.ingredient_name}
                        </span>
                        <span className="text-sm text-zinc-500 dark:text-zinc-400 font-semibold tabular-nums shrink-0">
                          {row.quantity != null ? `${row.quantity} ${row.unit_symbol ?? ''}`.trim() : t('pantry.some')}
                        </span>
                        <button
                          onClick={() => remove(row.id)}
                          aria-label={t('pantry.remove', { name: row.ingredient_name })}
                          className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center text-zinc-300 dark:text-zinc-600 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-500 transition-colors"
                        >
                          <span className="material-symbols-outlined text-[18px]">close</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* ── What it lets you cook ── */}
          <div className="lg:col-span-6 space-y-4">
            <div className="bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-[0_1px_8px_rgba(0,0,0,0.04)] border border-zinc-100 dark:border-zinc-800 space-y-4">
              <h2 className="font-headline font-bold text-lg">{t('pantry.cookTitle')}</h2>
              <p className="sc-hint">{t('pantry.cookHint')}</p>

              <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded-xl p-0.5">
                {[
                  { value: 1, label: t('pantry.exact') },
                  { value: 0.8, label: t('pantry.missingOne') },
                  { value: 0.5, label: t('pantry.halfway') },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => { setThreshold(opt.value); if (cookable) void check(opt.value); }}
                    className={`flex-1 px-3 py-1.5 rounded-lg text-[11px] font-black transition-colors ${
                      threshold === opt.value
                        ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                        : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <button
                onClick={() => check()}
                disabled={checking || !items?.length}
                className="w-full py-3.5 rounded-2xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-black hover:opacity-90 transition-all disabled:opacity-40"
              >
                {checking ? t('pantry.checking') : t('pantry.check')}
              </button>
              {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
            </div>

            {cookable !== null && (
              cookable.length === 0 ? (
                <div className="bg-white dark:bg-zinc-900 rounded-3xl p-10 text-center border border-zinc-100 dark:border-zinc-800">
                  <p className="text-sm text-zinc-400 dark:text-zinc-500 font-medium">{t('pantry.noneCookable')}</p>
                </div>
              ) : (
                cookable.map((r) => (
                  <Link
                    key={r.recipeId}
                    to={`/recipe/${r.recipeId}`}
                    className="flex gap-4 bg-white dark:bg-zinc-900 rounded-2xl p-4 border border-zinc-100 dark:border-zinc-800 hover:border-primary/30 transition-colors"
                  >
                    <span className="w-16 h-16 rounded-xl overflow-hidden bg-zinc-100 dark:bg-zinc-800 shrink-0 flex items-center justify-center">
                      {r.coverImageUrl
                        ? <ResolvedImage src={r.coverImageUrl} className="w-full h-full object-cover" />
                        : <RenderFaIcon name="TbSoup" className="text-xl text-zinc-300 dark:text-zinc-600" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-zinc-900 dark:text-zinc-100 truncate">{r.title}</p>
                      <p className="text-[11px] font-bold mt-0.5" style={{ color: r.matchRatio === 1 ? undefined : undefined }}>
                        <span className={r.matchRatio === 1 ? 'text-primary' : 'text-amber-600 dark:text-amber-500'}>
                          {r.matchRatio === 1
                            ? t('pantry.readyToCook')
                            : t('pantry.haveOf', { have: r.have, total: r.required })}
                        </span>
                      </p>
                      {r.missing.length > 0 && (
                        <p className="sc-hint mt-1 truncate">
                          {t('pantry.missing')} {r.missing.map((m) => m.name).join(', ')}
                        </p>
                      )}
                    </div>
                  </Link>
                ))
              )
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
