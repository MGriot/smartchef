import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton } from './Modal';
import { apiFetch } from '../lib/api';
import {
  buildCatalogProposals, catalogChangeFor, catalogProposalKinds, catalogSelectionKey, defaultCatalogSelection, isLossyChange,
  CATALOG_ASPECTS, type CatalogAspect, type CatalogChangeKind, type CatalogKind, type CatalogProposal, type CatalogSuggestion,
  type CatalogTidyItem,
} from '../lib/catalogTidy';

const BATCH: Record<CatalogKind, number> = { tools: 20, techniques: 20, units: 30, seasonality: 40 };
const REGION_KEY = 'smartchef.seasonality.region';
const aspectsKey = (kind: CatalogKind) => `smartchef.${kind}.tidyAspects`;

function loadAspects(kind: CatalogKind): Partial<Record<CatalogAspect, boolean>> {
  const all = Object.fromEntries(CATALOG_ASPECTS[kind].map((a) => [a, true]));
  try {
    const raw = localStorage.getItem(aspectsKey(kind));
    if (raw) return { ...all, ...JSON.parse(raw) };
  } catch { /* defaults */ }
  return all;
}

function defaultRegion(): string {
  try {
    const saved = localStorage.getItem(REGION_KEY);
    if (saved) return saved;
  } catch { /* none */ }
  try {
    const region = new Intl.Locale(navigator.language).region;
    if (region) return new Intl.DisplayNames(['en'], { type: 'region' }).of(region) ?? 'Italy';
  } catch { /* none */ }
  return 'Italy';
}

/** The router's own words for a refusal, or a generic one. */
async function failure(res: Response, fallback: string): Promise<Error> {
  const json = await res.json().catch(() => ({}));
  return new Error(typeof json.error === 'string' ? json.error : fallback);
}

/** "Tidy with AI" for the tools, techniques and units catalogs, and for
 *  ingredient seasonality: asks the configured AI to review each row,
 *  shows every proposed change with its own checkbox, applies only the
 *  ones left ticked. The ingredient catalog has its own, richer dialog
 *  (IngredientTidyModal). */
export default function CatalogTidyModal({
  kind,
  open,
  onClose,
  items,
  onApplied,
}: {
  kind: CatalogKind;
  open: boolean;
  onClose: () => void;
  items: CatalogTidyItem[];
  onApplied: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [phase, setPhase] = useState<'intro' | 'analysing' | 'review' | 'applying'>('intro');
  const [aspects, setAspects] = useState(() => loadAspects(kind));
  const [region, setRegion] = useState(defaultRegion);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [proposals, setProposals] = useState<CatalogProposal[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const available = CATALOG_ASPECTS[kind];
  const anyAspect = available.some((a) => aspects[a]);
  const busy = phase === 'analysing' || phase === 'applying';
  const monthName = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { month: 'short' });
    return (m: number) => fmt.format(new Date(2026, m - 1, 1));
  }, [i18n.language]);

  const close = () => {
    if (busy) return;
    setPhase('intro');
    setProposals([]);
    setError(null);
    onClose();
  };

  const setAspect = (aspect: CatalogAspect, value: boolean) => {
    const next = { ...aspects, [aspect]: value };
    setAspects(next);
    try { localStorage.setItem(aspectsKey(kind), JSON.stringify(next)); } catch { /* ignore */ }
  };

  const requestBatch = async (batch: CatalogTidyItem[]): Promise<CatalogSuggestion[]> => {
    if (kind === 'seasonality') {
      const res = await apiFetch('/api/ingredients/ai-season', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, items: batch.map((i) => ({ key: i.id, text: i.name, months: i.seasonal_months ?? [] })) }),
        timeoutMs: 650_000,
      });
      if (!res.ok) throw await failure(res, t('library.ai.failed'));
      const json = await res.json();
      return (json.data as Array<{ key: string; months: number[] }>).map((r) => ({ key: r.key, months: r.months }));
    }
    const res = await apiFetch(`/api/${kind}/ai-tidy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aspects,
        items: batch.map((i) => ({
          key: i.id,
          text: i.name,
          symbol: i.symbol ?? null,
          known: Object.fromEntries((i.translations ?? []).filter((tr) => tr.name).map((tr) => [tr.lang, tr.name])),
          description: i.description ?? null,
          category: i.category ?? null,
          synonyms: i.synonyms ?? [],
        })),
      }),
      timeoutMs: 650_000,
    });
    if (!res.ok) throw await failure(res, t('library.ai.failed'));
    return (await res.json()).data as CatalogSuggestion[];
  };

  const analyse = async () => {
    setError(null);
    setPhase('analysing');
    if (kind === 'seasonality') {
      try { localStorage.setItem(REGION_KEY, region); } catch { /* ignore */ }
    }
    const size = BATCH[kind];
    setProgress({ done: 0, total: items.length });
    const suggestions: CatalogSuggestion[] = [];
    // A batch the provider still refuses after its own retries is skipped,
    // not fatal: what came back is reviewed, and a second run covers the rest.
    let skipped = 0;
    let lastError: Error | null = null;
    for (let i = 0; i < items.length; i += size) {
      const batch = items.slice(i, i + size);
      try {
        suggestions.push(...(await requestBatch(batch)));
      } catch (err) {
        skipped += batch.length;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      setProgress({ done: Math.min(i + size, items.length), total: items.length });
    }
    if (suggestions.length === 0 && lastError) {
      setError(lastError.message);
      setPhase('intro');
      return;
    }
    if (skipped > 0) setError(t('library.ai.skipped', { count: skipped, error: lastError?.message ?? '' }));
    const found = buildCatalogProposals(items, suggestions);
    setProposals(found);
    setSelected(defaultCatalogSelection(found));
    setPhase('review');
  };

  const toApply = useMemo(
    () => proposals.map((p) => ({ p, body: catalogChangeFor(p, selected) })).filter((x): x is { p: CatalogProposal; body: Record<string, unknown> } => !!x.body),
    [proposals, selected],
  );

  const apply = async () => {
    setPhase('applying');
    setProgress({ done: 0, total: toApply.length });
    setError(null);
    try {
      for (let i = 0; i < toApply.length; i++) {
        const { p, body } = toApply[i];
        const url = kind === 'seasonality' ? `/api/ingredients/${p.id}/season` : `/api/${kind}/${p.id}/tidy`;
        const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) throw await failure(res, t('library.ai.failed'));
        setProgress({ done: i + 1, total: toApply.length });
      }
      onApplied();
      setPhase('intro');
      setProposals([]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.ai.failed'));
      setPhase('review');
    }
  };

  const toggle = (key: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const kindCounts = useMemo(() => {
    const counts = new Map<CatalogChangeKind, number>();
    for (const p of proposals) for (const k of catalogProposalKinds(p)) counts.set(k, (counts.get(k) ?? 0) + 1);
    return counts;
  }, [proposals]);

  const toggleKind = (kindOfChange: CatalogChangeKind) => {
    const keys = proposals.filter((p) => catalogProposalKinds(p).includes(kindOfChange)).map((p) => catalogSelectionKey(p.id, kindOfChange));
    const allOn = keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) { if (allOn) next.delete(k); else next.add(k); }
      return next;
    });
  };

  const months = (list: number[]) => (list.length ? list.map(monthName).join(', ') : t('library.ai.notSeasonal'));

  const describe = (p: CatalogProposal, change: CatalogChangeKind): string => {
    switch (change) {
      case 'name': return t('library.ai.rename', { from: p.oldName, to: p.newName });
      case 'addTranslations': return `+ ${p.addTranslations.map((tr) => `${tr.lang.toUpperCase()} ${tr.text}`).join(' · ')}`;
      case 'fixTranslations': return p.fixTranslations.map((f) => t('library.ai.fixTranslation', { lang: f.lang.toUpperCase(), from: f.from, to: f.to })).join(' · ');
      case 'description': return p.description?.from
        ? t('library.ai.fixDescription', { to: p.description.to })
        : t('library.ai.addDescription', { to: p.description?.to });
      case 'category': return t('library.ai.category', { from: p.category?.from || t('library.ai.none'), to: p.category?.to });
      case 'synonyms': return t('library.ai.synonyms', { list: p.addSynonyms.join(', ') });
      case 'months': return t('library.ai.months', { from: months(p.months?.from ?? []), to: months(p.months?.to ?? []) });
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      closeOnBackdrop={!busy}
      title={t(`library.ai.title.${kind}`)}
      subtitle={t(`library.ai.subtitle.${kind}`)}
      footer={
        <>
          <ModalCancelButton onClick={close}>{t('common.cancel')}</ModalCancelButton>
          {phase === 'intro' && (
            <button type="button" onClick={analyse} disabled={items.length === 0 || !anyAspect || (kind === 'seasonality' && !region.trim())} className="px-6 py-3 rounded-full bg-primary text-white font-bold disabled:opacity-50">
              {t('library.ai.analyse', { count: items.length })}
            </button>
          )}
          {(phase === 'review' || phase === 'applying') && (
            <button type="button" onClick={apply} disabled={busy || toApply.length === 0} className="px-6 py-3 rounded-full bg-primary text-white font-bold disabled:opacity-50">
              {phase === 'applying'
                ? t('library.ai.applying', { done: progress.done, total: progress.total })
                : t('library.ai.apply', { count: toApply.length })}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {phase === 'intro' && (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">{t(`library.ai.intro.${kind}`)}</p>
            {kind === 'seasonality' ? (
              <label className="block">
                <span className="block text-[10px] font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-2">{t('library.ai.region')}</span>
                <input type="text" value={region} onChange={(e) => setRegion(e.target.value)} className="sc-field" placeholder="Italy" />
                <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('library.ai.regionHint')}</span>
              </label>
            ) : available.length > 1 && (
              <fieldset className="space-y-2">
                <legend className="text-[10px] font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-2">{t('library.ai.aspects')}</legend>
                {available.map((aspect) => (
                  <label key={aspect} className="flex items-start gap-3 rounded-2xl border border-zinc-100 dark:border-zinc-800 p-3 cursor-pointer">
                    <input type="checkbox" className="mt-1 accent-primary" checked={!!aspects[aspect]} onChange={(e) => setAspect(aspect, e.target.checked)} />
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-zinc-800 dark:text-zinc-100">{t(`library.ai.aspect.${aspect}`)}</span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">{t(`library.ai.aspectHint.${aspect}`)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </>
        )}
        {phase === 'analysing' && (
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{t('library.ai.analysing', { done: progress.done, total: progress.total })}</p>
        )}
        {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        {(phase === 'review' || phase === 'applying') && proposals.length === 0 && (
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{t('library.ai.nothing')}</p>
        )}
        {(phase === 'review' || phase === 'applying') && proposals.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              {[...kindCounts.entries()].map(([change, count]) => {
                const keys = proposals.filter((p) => catalogProposalKinds(p).includes(change)).map((p) => catalogSelectionKey(p.id, change));
                const on = keys.filter((k) => selected.has(k)).length;
                return (
                  <button
                    key={change}
                    type="button"
                    disabled={busy}
                    onClick={() => toggleKind(change)}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
                      on === count ? 'border-primary/40 bg-primary/10 text-primary'
                        : on === 0 ? 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400'
                          : 'border-primary/30 text-primary'
                    }`}
                  >
                    {t(`library.ai.kind.${change}`)} {on}/{count}
                  </button>
                );
              })}
            </div>
            <ul className="space-y-2">
              {proposals.map((p) => (
                <li key={p.id} className="rounded-2xl border border-zinc-100 dark:border-zinc-800 p-3 text-sm">
                  <p className="font-bold text-zinc-800 dark:text-zinc-100 break-words">{p.oldName}</p>
                  {p.duplicateOf && <p className="text-xs text-amber-700">{t('library.ai.duplicate', { name: p.duplicateOf.name })}</p>}
                  <div className="mt-1.5 space-y-1">
                    {catalogProposalKinds(p).map((change) => {
                      const key = catalogSelectionKey(p.id, change);
                      const isFix = change === 'fixTranslations' || isLossyChange(p, change) || (change === 'months' && (p.months?.from.length ?? 0) > 0);
                      return (
                        <label key={change} className="flex items-start gap-2.5 cursor-pointer">
                          <input type="checkbox" className="mt-0.5 accent-primary" checked={selected.has(key)} disabled={busy} onChange={() => toggle(key)} />
                          <span className={`min-w-0 text-xs break-words ${isFix ? 'text-amber-700 dark:text-amber-500' : 'text-zinc-600 dark:text-zinc-300'}`}>
                            {describe(p, change)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
