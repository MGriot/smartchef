import { useTranslation } from 'react-i18next';
import Autocomplete, { type AutocompleteOption } from './Autocomplete';
import Modal, { ModalCancelButton, ModalSubmitButton } from './Modal';
import { AddLangButton, Field, FormSection, TranslationRows } from './Form';
import SynonymsEditor from './SynonymsEditor';
import RenderFaIcon from './RenderFaIcon';
import { ResolvedImage } from './CoverImage';

// ════════════════════════════════════════════════════════════════════════
// The pieces the Tools, Techniques and Tags library sections had each
// copied: the merge dialog, the Naming section of the edit dialog, and —
// for the two sections that list items with a picture — the thumbnail and
// the edit / merge / delete buttons. Each section still owns its state and
// its own wording; these take the already-translated strings.
// ════════════════════════════════════════════════════════════════════════

export interface CatalogMergeModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  hint: string;
  placeholder: string;
  options: AutocompleteOption[];
  targetId: string;
  onTargetChange: (id: string) => void;
  merging: boolean;
  onMerge: () => void;
}

/** Fold one catalog entry into another. Uses Autocomplete rather than an
 *  input plus a filtered list: the typed text stays inside the control, so
 *  the page behind the dialog doesn't re-render on every keystroke, arrow
 *  keys and Enter work, and a choice can be corrected without clearing the
 *  box first. `options` must keep its identity between renders — the
 *  control re-syncs its text whenever that array changes. */
export function CatalogMergeModal({
  open, onClose, title, subtitle, hint, placeholder, options, targetId, onTargetChange, merging, onMerge,
}: CatalogMergeModalProps) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      zIndex={120}
      title={title}
      subtitle={subtitle}
      footer={
        <>
          <ModalCancelButton onClick={onClose}>{t('common.cancel')}</ModalCancelButton>
          <ModalSubmitButton type="button" onClick={onMerge} disabled={!targetId || merging}>
            {merging ? t('library.shared.merging') : t('library.shared.merge')}
          </ModalSubmitButton>
        </>
      }
    >
      <Field label={t('library.shared.mergeIntoLabel')} hint={hint}>
        <Autocomplete
          options={options}
          value={targetId || null}
          onSelect={(id) => onTargetChange(id)}
          onClear={() => onTargetChange('')}
          placeholder={placeholder}
          className="sc-field"
        />
      </Field>
    </Modal>
  );
}

// A type alias, not an interface: TranslationRows takes LangEntry's index
// signature, which only object type literals satisfy implicitly.
type Translation = { lang: string; name: string };

export interface CatalogNamingSectionProps {
  description: string;
  synonyms: string[];
  onSynonymsChange: (synonyms: string[]) => void;
  translations: Translation[];
  onTranslationsChange: (translations: Translation[]) => void;
}

/** Synonyms and per-language names, the last section of each edit dialog. */
export function CatalogNamingSection({
  description, synonyms, onSynonymsChange, translations, onTranslationsChange,
}: CatalogNamingSectionProps) {
  const { t } = useTranslation();
  return (
    <FormSection
      title={t('library.shared.sectionNaming')}
      description={description}
      action={<AddLangButton onClick={() => onTranslationsChange([...translations, { lang: '', name: '' }])} label={t('library.shared.addLang')} />}
    >
      <Field label={t('library.shared.synonyms')}>
        <SynonymsEditor value={synonyms} onChange={onSynonymsChange} />
      </Field>
      <Field label={t('library.shared.translations')}>
        <TranslationRows
          value={translations}
          onChange={onTranslationsChange}
          emptyLabel={t('library.shared.noTranslations')}
          textPlaceholder={t('library.shared.translatedNamePlaceholder')}
        />
      </Field>
    </FormSection>
  );
}

type CatalogLayout = 'tile' | 'row';

/** The item's first photo, or its icon when it has none. */
export function CatalogThumb({ imageUrls, icon, layout }: { imageUrls?: string[]; icon: string; layout: CatalogLayout }) {
  if (layout === 'tile') {
    return (
      <div className="aspect-square rounded-2xl overflow-hidden bg-white dark:bg-zinc-900 flex items-center justify-center mb-3">
        {imageUrls?.[0] ? (
          <ResolvedImage src={imageUrls[0]} className="w-full h-full object-cover" />
        ) : (
          <RenderFaIcon name={icon} className="text-[32px] text-zinc-300 dark:text-zinc-600" />
        )}
      </div>
    );
  }
  return imageUrls?.[0] ? (
    <ResolvedImage src={imageUrls[0]} className="w-12 h-12 rounded-2xl object-cover bg-zinc-100 dark:bg-zinc-800" />
  ) : (
    <div className="w-12 h-12 bg-zinc-100 dark:bg-zinc-800 rounded-2xl flex items-center justify-center text-xl text-zinc-400 dark:text-zinc-500">
      <RenderFaIcon name={icon} className="text-[20px]" />
    </div>
  );
}

export interface CatalogItemActionsProps {
  layout: CatalogLayout;
  editTitle: string;
  mergeTitle: string;
  onEdit: () => void;
  onMerge: () => void;
  onDelete: () => void;
}

/** Edit, merge and delete. On a tile they are revealed on hover so the grid
 *  stays readable as a catalog at a glance; on a table row they sit in the
 *  actions column. */
export function CatalogItemActions({ layout, editTitle, mergeTitle, onEdit, onMerge, onDelete }: CatalogItemActionsProps) {
  const { t } = useTranslation();
  if (layout === 'tile') {
    const button = (hover: string) => `w-8 h-8 rounded-full hover:bg-white dark:hover:bg-zinc-900 flex items-center justify-center text-zinc-400 dark:text-zinc-500 ${hover} transition-all`;
    return (
      <div className="flex justify-center gap-1 mt-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button onClick={onEdit} title={editTitle} className={button('hover:text-primary')}>
          <span className="material-symbols-outlined text-[18px]">edit</span>
        </button>
        <button onClick={onMerge} title={mergeTitle} className={button('hover:text-primary')}>
          <span className="material-symbols-outlined text-[18px]">call_merge</span>
        </button>
        <button onClick={onDelete} title={t('common.delete')} className={button('hover:text-tertiary')}>
          <span className="material-symbols-outlined text-[18px]">delete</span>
        </button>
      </div>
    );
  }
  const button = (hover: string) => `w-10 h-10 rounded-full hover:bg-white dark:hover:bg-zinc-900 hover:shadow-sm flex items-center justify-center text-zinc-400 dark:text-zinc-500 ${hover} transition-all`;
  return (
    <div className="flex justify-end gap-2">
      <button onClick={onEdit} title={editTitle} className={button('hover:text-primary')}>
        <span className="material-symbols-outlined text-xl">edit</span>
      </button>
      <button onClick={onMerge} title={mergeTitle} className={button('hover:text-primary')}>
        <span className="material-symbols-outlined text-xl">call_merge</span>
      </button>
      <button onClick={onDelete} className={button('hover:text-tertiary')}>
        <span className="material-symbols-outlined text-xl">delete</span>
      </button>
    </div>
  );
}
