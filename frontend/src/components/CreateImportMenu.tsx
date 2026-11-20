import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ActionMenu from './ActionMenu';

/** One "+" entry point for adding a recipe: a small chooser with Create and
 *  Import, on the shared ActionMenu (a popover under the button on wide
 *  screens, a bottom sheet on a phone). */
export default function CreateImportMenu({ variant }: { variant: 'header' | 'menu' }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

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
      <ActionMenu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        label={t('nav.addRecipe')}
        views={{
          main: {
            sections: [{
              items: [
                { key: 'create', icon: 'edit_note', label: t('nav.createRecipe'), onSelect: () => navigate('/recipe/new') },
                { key: 'import', icon: 'download', label: t('nav.importRecipe'), onSelect: () => navigate('/import') },
              ],
            }],
          },
        }}
      />
    </>
  );
}
