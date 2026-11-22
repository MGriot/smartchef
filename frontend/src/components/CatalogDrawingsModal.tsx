import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton } from './Modal';
import { ResolvedImage } from './CoverImage';
import { apiFetch } from '../lib/api';
import { isLocalImagePath } from '../lib/localImages';

export type DrawingKind = 'ingredients' | 'tools' | 'techniques';

export interface DrawableItem {
  id: string;
  name: string;
  translated_name?: string | null;
  description?: string | null;
  image_urls?: string[];
}

const REFERENCE_KEY = 'smartchef.drawings.reference';
/** Two at a time: about twice as fast as one, and gentle enough on a
 *  per-minute image quota that the provider's own retries absorb it. */
const PARALLEL = 2;

const hasPicture = (i: DrawableItem) => (i.image_urls ?? []).some((u) => !!u?.trim());

/** The "missing pictures" dialog: an AI illustration for every row of this
 *  catalog that has no picture yet, in the style of one reference picture
 *  from the user's own library — by default the first ingredient that has
 *  one. Each picture is saved as it arrives, so stopping halfway keeps
 *  what was painted and the next run picks up the rest. */
export default function CatalogDrawingsModal({
  kind,
  open,
  onClose,
  items,
  onDrawn,
}: {
  kind: DrawingKind;
  open: boolean;
  onClose: () => void;
  items: DrawableItem[];
  onDrawn: () => void;
}) {
  const { t } = useTranslation();
  const [references, setReferences] = useState<Array<{ path: string; name: string }>>([]);
  const [reference, setReference] = useState<string | null>(() => {
    try { return localStorage.getItem(REFERENCE_KEY); } catch { return null; }
  });
  const [phase, setPhase] = useState<'intro' | 'drawing' | 'done'>('intro');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [recent, setRecent] = useState<Array<{ name: string; path: string }>>([]);
  const [failures, setFailures] = useState<Array<{ name: string; error: string }>>([]);
  const stop = useRef(false);

  const missing = useMemo(() => items.filter((i) => !hasPicture(i)), [items]);

  // Every local picture in the library is a candidate style reference,
  // ingredients first.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const found: Array<{ path: string; name: string }> = [];
      for (const ns of ['ingredients', 'tools', 'techniques']) {
        try {
          const json = await (await apiFetch(`/api/${ns}`)).json();
          for (const row of (json.data ?? []) as DrawableItem[]) {
            const path = (row.image_urls ?? []).find((u) => isLocalImagePath(u));
            if (path && !found.some((f) => f.path === path)) found.push({ path, name: row.name });
          }
        } catch { /* that catalog has none to offer */ }
      }
      if (cancelled) return;
      setReferences(found);
      setReference((current) => (current && found.some((f) => f.path === current) ? current : found[0]?.path ?? null));
    })();
    return () => { cancelled = true; };
  }, [open]);

  const busy = phase === 'drawing';

  const close = () => {
    if (busy) { stop.current = true; return; }
    setPhase('intro');
    setRecent([]);
    setFailures([]);
    onClose();
  };

  const paintAll = async () => {
    if (reference) {
      try { localStorage.setItem(REFERENCE_KEY, reference); } catch { /* ignore */ }
    }
    stop.current = false;
    setPhase('drawing');
    setRecent([]);
    setFailures([]);
    const queue = [...missing];
    let done = 0;
    setProgress({ done: 0, total: queue.length });
    const worker = async () => {
      while (!stop.current) {
        const item = queue.shift();
        if (!item) return;
        try {
          const res = await apiFetch(`/api/${kind}/ai-paint`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id, name: item.name, description: item.description ?? null, referencePath: reference }),
            timeoutMs: 600_000,
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('library.ai.failed'));
          setRecent((r) => [{ name: item.translated_name || item.name, path: json.data.path as string }, ...r].slice(0, 12));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setFailures((f) => [...f, { name: item.translated_name || item.name, error: message }]);
          // A key or quota problem fails every item the same way: stop
          // rather than burn through the list. A free-tier Gemini key
          // answers 429 "Quota exceeded … limit: 0" for every picture.
          if (/HTTP (400|401|403)\b|key|quota/i.test(message)) stop.current = true;
        }
        done += 1;
        setProgress({ done, total: missing.length });
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setPhase('done');
    onDrawn();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      closeOnBackdrop={!busy}
      title={t('library.ai.pictureTitle')}
      subtitle={t('library.ai.pictureSubtitle', { count: missing.length })}
      footer={
        <>
          <ModalCancelButton onClick={close}>{busy ? t('library.ai.pictureStop') : t('common.close')}</ModalCancelButton>
          {phase === 'intro' && (
            <button type="button" onClick={paintAll} disabled={missing.length === 0} className="px-6 py-3 rounded-full bg-primary text-white font-bold disabled:opacity-50">
              {t('library.ai.pictureStart', { count: missing.length })}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {phase === 'intro' && (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">{t('library.ai.pictureIntro')}</p>
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500 mb-2">{t('library.ai.pictureReference')}</p>
              {references.length === 0 ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('library.ai.pictureNoReference')}</p>
              ) : (
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                  {references.slice(0, 24).map((r) => (
                    <button
                      key={r.path}
                      type="button"
                      title={r.name}
                      onClick={() => setReference(r.path)}
                      className={`aspect-square rounded-xl overflow-hidden border-2 ${reference === r.path ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100'}`}
                    >
                      <ResolvedImage src={r.path} alt={r.name} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        {phase !== 'intro' && (
          <p className="text-sm font-bold text-zinc-700 dark:text-zinc-200">
            {phase === 'drawing'
              ? t('library.ai.pictureProgress', { done: progress.done, total: progress.total })
              : t('library.ai.pictureDone', { count: progress.done - failures.length, failed: failures.length })}
          </p>
        )}
        {recent.length > 0 && (
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {recent.map((r) => (
              <figure key={r.path} className="min-w-0">
                <ResolvedImage src={r.path} alt={r.name} className="w-full aspect-square rounded-xl object-cover" />
                <figcaption className="text-[10px] text-zinc-500 truncate mt-1">{r.name}</figcaption>
              </figure>
            ))}
          </div>
        )}
        {failures.length > 0 && (
          <ul className="text-xs text-red-600 space-y-1 max-h-40 overflow-y-auto">
            {failures.map((f, i) => <li key={i} className="break-words"><b>{f.name}</b>: {f.error}</li>)}
          </ul>
        )}
      </div>
    </Modal>
  );
}
