import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal, { ModalCancelButton } from './Modal';
import { apiFetch, isNative, getServerUrl } from '../lib/api';

interface ShareLink {
  token: string;
  createdAt: string;
  expiresAt: string | null;
  viewCount: number;
  lastSeenAt: string | null;
}

/** Create, show and revoke a recipe's public link.
 *
 *  Server mode only. A public URL needs a server that is running and
 *  reachable, and standalone mode's whole premise is that there isn't one —
 *  so rather than a button that fails, the offline build says why and
 *  points at the file export, which does work there. Deciding that here
 *  keeps the explanation next to the feature instead of leaving a dead
 *  control on the recipe page. */
export default function ShareLinkModal({
  open, onClose, recipeId, standalone, onExportFile,
}: {
  open: boolean;
  onClose: () => void;
  recipeId: string;
  standalone: boolean;
  onExportFile: () => void;
}) {
  const { t } = useTranslation();
  const [link, setLink] = useState<ShareLink | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || standalone) return;
    setLoading(true);
    setError(null);
    apiFetch(`/api/share/links/${recipeId}`)
      .then((r) => r.json())
      .then((j) => setLink(j.data ?? null))
      .catch(() => setLink(null))
      .finally(() => setLoading(false));

    // On native the app runs from capacitor://, so the shareable origin is
    // the configured server's, not window.location's.
    if (isNative()) getServerUrl().then((u) => setOrigin(u ?? ''));
    else setOrigin(window.location.origin);
  }, [open, standalone, recipeId]);

  const url = link ? `${origin}/api/public/r/${link.token}` : '';

  const create = async (expiresInDays?: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/share/links/${recipeId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(expiresInDays ? { expiresInDays } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : t('share.failed'));
      setLink({ token: json.data.token, createdAt: new Date().toISOString(), expiresAt: null, viewCount: 0, lastSeenAt: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('share.failed'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await apiFetch(`/api/share/links/${recipeId}`, { method: 'DELETE' });
      setLink(null);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the URL is on screen and selectable */
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={t('share.title')}
      subtitle={standalone ? undefined : t('share.subtitle')}
      footer={<ModalCancelButton onClick={onClose}>{t('common.cancel')}</ModalCancelButton>}
    >
      {standalone ? (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{t('share.offlineExplain')}</p>
          <button
            type="button"
            onClick={() => { onExportFile(); onClose(); }}
            className="w-full py-3.5 rounded-2xl bg-primary text-white font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all"
          >
            {t('share.offlineExport')}
          </button>
        </div>
      ) : loading ? (
        <p className="text-sm text-zinc-400 dark:text-zinc-500">{t('common.loading')}</p>
      ) : link ? (
        <div className="space-y-4">
          <div className="sc-panel p-3">
            <p className="font-mono text-xs break-all text-zinc-700 dark:text-zinc-300">{url}</p>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={copy}
              className="flex-1 py-3 rounded-2xl bg-primary text-white font-black hover:bg-primary/90 transition-all"
            >
              {copied ? t('share.copied') : t('share.copy')}
            </button>
            <button
              type="button"
              onClick={revoke}
              disabled={busy}
              className="px-5 py-3 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              {t('share.revoke')}
            </button>
          </div>

          <p className="sc-hint">
            {link.viewCount > 0 ? t('share.viewed', { count: link.viewCount }) : t('share.notViewed')}
          </p>
          <p className="sc-hint">{t('share.scope')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">{t('share.explain')}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => create()}
              disabled={busy}
              className="flex-1 py-3.5 rounded-2xl bg-primary text-white font-black shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all disabled:opacity-50"
            >
              {t('share.create')}
            </button>
            <button
              type="button"
              onClick={() => create(7)}
              disabled={busy}
              className="px-5 py-3.5 rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-black hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              {t('share.create7d')}
            </button>
          </div>
          <p className="sc-hint">{t('share.reachability')}</p>
        </div>
      )}
      {error && <p className="mt-4 text-sm text-red-600 font-medium">{error}</p>}
    </Modal>
  );
}
