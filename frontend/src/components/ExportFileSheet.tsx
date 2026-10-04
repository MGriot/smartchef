import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { saveExportFile, shareExportFile, type ExportFile, type SaveOptions } from '../lib/fileExport';

/** Android's "what do you want to do with this file" step. On a phone
 *  there are two equally real answers — keep it (the system "save as"
 *  picker) or send it somewhere (the share sheet) — and no single default
 *  that is right for both, so the user picks. Electron and the web never
 *  show this: they have one save dialog and go straight to it (see
 *  hooks/useFileExport.tsx). */
export default function ExportFileSheet({ file, saveOptions, onClose }: {
  file: ExportFile;
  saveOptions?: SaveOptions;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      console.error('File export failed:', err);
      setError(err instanceof Error && err.message ? err.message : t('fileExport.failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = () => run(async () => {
    const saved = await saveExportFile(file, saveOptions);
    if (saved) setSavedAs(saved.location || saved.fileName);
  });

  const handleShare = () => run(async () => {
    await shareExportFile(file, t('fileExport.shareTitle'));
    onClose();
  });

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/50 no-print" onClick={busy ? undefined : onClose}>
      <div
        className="w-full sm:max-w-sm bg-white dark:bg-zinc-900 rounded-t-3xl sm:rounded-3xl shadow-2xl border border-zinc-100 dark:border-zinc-800 p-6"
        style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('fileExport.title')}
      >
        <p className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">{t('fileExport.title')}</p>
        <p className="mt-1 text-sm font-bold text-zinc-900 dark:text-zinc-100 break-all">{file.fileName}</p>

        {savedAs ? (
          <p className="mt-4 flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <span className="material-symbols-outlined text-[18px]">check_circle</span>
            <span className="break-all">{t('fileExport.savedAs', { name: savedAs })}</span>
          </p>
        ) : (
          <div className="mt-5 space-y-2">
            <button
              onClick={handleSave}
              disabled={busy}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold text-white bg-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              <span className="material-symbols-outlined text-[20px]">download</span>
              {t('fileExport.saveToDevice')}
            </button>
            <button
              onClick={handleShare}
              disabled={busy}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold text-zinc-700 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">ios_share</span>
              {t('fileExport.share')}
            </button>
          </div>
        )}

        {error && <p className="mt-3 text-xs text-red-600 dark:text-red-400 break-words">{error}</p>}

        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-sm font-bold text-zinc-500 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors"
          >
            {savedAs ? t('common.close') : t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
