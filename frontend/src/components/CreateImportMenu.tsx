import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const ITEM = 'w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors flex items-center gap-2.5';

/** One "+" entry point for adding a recipe: a small chooser with Create and
 *  Import. A popover under the button on wide screens, a bottom sheet on a
 *  phone. Portalled and `fixed` so the header can't clip it. */
export default function CreateImportMenu({ variant }: { variant: 'header' | 'menu' }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 288;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    setPos({ top: rect.bottom + 6, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const go = (to: string) => { setOpen(false); navigate(to); };

  const trigger =
    variant === 'header' ? (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t('nav.addRecipe')}
        aria-label={t('nav.addRecipe')}
        aria-haspopup="menu"
        aria-expanded={open}
        className="hidden sm:flex items-center gap-1.5 px-3 xl:px-4 py-2 bg-primary text-white rounded-full font-bold text-xs shadow-sm shadow-primary/20 hover:bg-primary/90 transition-all active:scale-95 whitespace-nowrap"
      >
        <span className="material-symbols-outlined text-[16px]">add</span>
        <span className="hidden xl:inline">{t('nav.addRecipe')}</span>
      </button>
    ) : (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 bg-primary text-white rounded-xl font-bold text-sm mb-2"
      >
        <span className="material-symbols-outlined text-[20px]">add</span>
        {t('nav.addRecipe')}
      </button>
    );

  return (
    <>
      {trigger}
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-[60] max-sm:bg-black/30" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="fixed z-[61] max-sm:inset-x-3 max-sm:bottom-3 sm:w-72 bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-zinc-100 dark:border-zinc-800 p-2"
            style={pos && window.innerWidth >= 640 ? { top: pos.top, left: pos.left } : undefined}
          >
            <button type="button" role="menuitem" className={ITEM} onClick={() => go('/recipe/new')}>
              <span className="material-symbols-outlined text-[18px]">edit_note</span>{t('nav.createRecipe')}
            </button>
            <button type="button" role="menuitem" className={ITEM} onClick={() => go('/import')}>
              <span className="material-symbols-outlined text-[18px]">download</span>{t('nav.importRecipe')}
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
