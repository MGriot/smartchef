import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CookidooExport } from '../lib/cookidooExport';

/** The Cookidoo (Bimby/Thermomix) export: every field of the recipe as a
 *  block with its own Copy button, since Cookidoo's recipe editor takes them
 *  one field at a time. Opened from the recipe page and from a gallery card. */
export default function CookidooExportModal({
  data,
  onClose,
  onDownload,
}: {
  data: CookidooExport | null;
  onClose: () => void;
  onDownload: (fullText: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  if (!data) return null;

  const copy = async (text: string, key: string) => {
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
    setCopied(key);
    window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('recipeDetail.cookidoo.title')}
        className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-white dark:bg-zinc-900 rounded-3xl shadow-2xl border border-zinc-100 dark:border-zinc-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 p-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <h2 className="text-lg font-black text-zinc-900 dark:text-zinc-100">{t('recipeDetail.cookidoo.title')}</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('recipeDetail.cookidoo.hint')}</p>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            aria-label={t('common.cancel')}
          >
            <span className="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {data.sections.map((section) => (
            <div key={section.key}>
              <div className="flex items-center justify-between gap-3 mb-1.5">
                <span className="text-[10px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">{section.label}</span>
                <button onClick={() => copy(section.text, section.key)} className="text-xs font-bold text-primary hover:opacity-70 transition-opacity">
                  {copied === section.key ? t('recipeDetail.cookidoo.copied') : t('recipeDetail.cookidoo.copy')}
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
            onClick={() => onDownload(data.fullText)}
            className="px-4 py-2.5 rounded-xl text-sm font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            {t('recipeDetail.cookidoo.download')}
          </button>
          <button
            onClick={() => copy(data.fullText, '__all__')}
            className="px-4 py-2.5 rounded-xl text-sm font-bold text-white bg-primary hover:opacity-90 transition-opacity"
          >
            {copied === '__all__' ? t('recipeDetail.cookidoo.copied') : t('recipeDetail.cookidoo.copyAll')}
          </button>
        </div>
      </div>
    </div>
  );
}
