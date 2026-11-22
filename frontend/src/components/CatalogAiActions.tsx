import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CatalogTidyModal from './CatalogTidyModal';
import CatalogDrawingsModal, { type DrawableItem, type DrawingKind } from './CatalogDrawingsModal';
import type { CatalogKind, CatalogTidyItem } from '../lib/catalogTidy';

const BUTTON = 'shrink-0 flex items-center gap-2 p-3 sm:px-5 sm:py-3 rounded-full font-bold border border-primary/30 text-primary hover:bg-primary/5 transition-all active:scale-95';

/** The Library header's AI buttons — "Tidy with AI" and the pictures button —
 *  with their dialogs. Standalone mode only: the routes live in
 *  services/localRouter.ts, and server mode has no counterpart. Icon-only
 *  on a phone, like the other header buttons. */
export default function CatalogAiActions({
  tidyKind,
  pictureKind,
  items,
  onChanged,
}: {
  tidyKind?: CatalogKind;
  pictureKind?: DrawingKind;
  items: Array<CatalogTidyItem & DrawableItem>;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [standalone, setStandalone] = useState(false);
  const [showTidy, setShowTidy] = useState(false);
  const [showDraw, setShowDraw] = useState(false);

  useEffect(() => {
    import('../lib/standalone').then(({ isStandaloneMode }) => isStandaloneMode()).then(setStandalone).catch(() => setStandalone(false));
  }, []);

  if (!standalone) return null;
  return (
    <>
      {tidyKind && (
        <button type="button" onClick={() => setShowTidy(true)} aria-label={t('library.ai.button')} title={t('library.ai.button')} className={BUTTON}>
          <span className="material-symbols-outlined">auto_fix_high</span>
          <span className="hidden sm:inline">{t('library.ai.button')}</span>
        </button>
      )}
      {pictureKind && (
        <button type="button" onClick={() => setShowDraw(true)} aria-label={t('library.ai.pictureButton')} title={t('library.ai.pictureButton')} className={BUTTON}>
          <span className="material-symbols-outlined">palette</span>
          <span className="hidden sm:inline">{t('library.ai.pictureButton')}</span>
        </button>
      )}
      {tidyKind && (
        <CatalogTidyModal kind={tidyKind} open={showTidy} onClose={() => setShowTidy(false)} items={items} onApplied={onChanged} />
      )}
      {pictureKind && (
        <CatalogDrawingsModal kind={pictureKind} open={showDraw} onClose={() => setShowDraw(false)} items={items} onDrawn={onChanged} />
      )}
    </>
  );
}
