import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import { canPrint, canSavePdfDirectly } from '../lib/print';
import { PAPER_SIZES, type PaperSize } from '../lib/paperSize';

const isAndroidApp = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** The screen-only bar above a print view: back, the view's own options
 *  (`children`), the paper size, and Save PDF / Print. Shared by the recipe
 *  report, the menu card and the weekly plan so all three behave the same.
 *  Wrapped in `no-print`, so none of it reaches the paper. */
export default function PrintToolbar({
  title, onBack, paper, onPaperChange, maxWidth, children, preparing = false, disabled = false,
  onPrint, onSavePdf, error, savedTo,
}: {
  title: string;
  onBack: () => void;
  paper: PaperSize;
  onPaperChange: (paper: PaperSize) => void;
  /** CSS width the bar's content is centred in — the sheet's own width. */
  maxWidth: string;
  /** Option controls (servings, toggles…) shown under the title row. */
  children?: ReactNode;
  /** Shows "Preparing images…" while the view waits for photos. */
  preparing?: boolean;
  disabled?: boolean;
  onPrint: () => void;
  onSavePdf: () => void;
  error?: string | null;
  savedTo?: string | null;
}) {
  const { t } = useTranslation();
  const printLabel = isAndroidApp() ? t('print.report.printOrSavePdf') : t('print.report.print');

  return (
    <div
      className="no-print sticky top-0 z-30 bg-white/95 dark:bg-zinc-900/95 backdrop-blur border-b border-zinc-200 dark:border-zinc-800"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="mx-auto px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-3" style={{ maxWidth }}>
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-sm font-bold text-zinc-600 dark:text-zinc-300 hover:text-primary transition-colors"
          aria-label={t('common.back')}
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          <span className="hidden sm:inline">{t('common.back')}</span>
        </button>
        <p className="text-sm font-black text-zinc-900 dark:text-zinc-100 mr-auto">{title}</p>

        <div className="flex items-center gap-2" role="group" aria-label={t('print.paper.label')}>
          <span className="text-[10px] font-black uppercase tracking-widest text-zinc-400 dark:text-zinc-500">{t('print.paper.label')}</span>
          <div className="flex bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
            {PAPER_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => onPaperChange(size)}
                aria-pressed={paper === size}
                className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-wider transition-colors ${
                  paper === size
                    ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-sm'
                    : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300'
                }`}
              >
                {size === 'A4' ? t('print.paper.a4') : t('print.paper.letter')}
              </button>
            ))}
          </div>
        </div>

        <div className="w-full flex flex-wrap items-center gap-2">
          {children}

          <div className="ml-auto flex items-center gap-2">
            {preparing && (
              <span className="text-xs text-zinc-400 dark:text-zinc-500 animate-pulse">{t('print.report.preparing')}</span>
            )}
            {canSavePdfDirectly() && (
              <button
                onClick={onSavePdf}
                disabled={disabled}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold text-zinc-700 dark:text-zinc-200 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors"
              >
                <span className="material-symbols-outlined text-[18px]">picture_as_pdf</span>
                {t('print.report.savePdf')}
              </button>
            )}
            {canPrint() && (
              <button
                onClick={onPrint}
                disabled={disabled}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold text-white bg-primary hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                <span className="material-symbols-outlined text-[18px]">print</span>
                {printLabel}
              </button>
            )}
          </div>
        </div>
        {(error || savedTo) && (
          <p className={`w-full text-xs ${error ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'} break-all`}>
            {error || t('print.report.savedTo', { location: savedTo })}
          </p>
        )}
      </div>
    </div>
  );
}
