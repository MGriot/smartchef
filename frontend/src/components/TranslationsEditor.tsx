import { useTranslation } from 'react-i18next';
import { useLanguages } from '../hooks/useLanguages';

export interface TranslationEntry {
  lang: string;
  title?: string;
  description?: string;
  notes?: string;
}

interface TranslationsEditorProps {
  translations: TranslationEntry[];
  onChange: (translations: TranslationEntry[]) => void;
  titleLabel?: string;
  descriptionLabel?: string;
  notesLabel?: string;
  showTitleDescription?: boolean;
  compact?: boolean;
}

/**
 * Add/remove a list of {lang, title, description, notes} translation entries.
 * Same pattern as the ad hoc translations list in LibraryIngredients.tsx,
 * componentized since recipes need it at two levels (recipe + each step).
 * The notes field only renders when notesLabel is passed (recipe-level
 * translations don't have a notes concept); title/description can be hidden
 * entirely via showTitleDescription for notes-only editors (ingredient lines).
 */
export default function TranslationsEditor({
  translations, onChange, titleLabel, descriptionLabel, notesLabel,
  showTitleDescription = true, compact = false,
}: TranslationsEditorProps) {
  const { t } = useTranslation();
  const { languages } = useLanguages();
  const resolvedTitleLabel = titleLabel ?? t('common.title');
  const resolvedDescriptionLabel = descriptionLabel ?? t('recipeDetail.description');

  const update = (idx: number, field: keyof TranslationEntry, value: string) =>
    onChange(translations.map((t, i) => i === idx ? { ...t, [field]: value } : t));

  const add = () => onChange([...translations, { lang: '', title: '', description: '', notes: '' }]);
  const remove = (idx: number) => onChange(translations.filter((_, i) => i !== idx));

  return (
    <div className="space-y-2">
      {translations.map((tr, idx) => (
        <div key={idx} className={`flex gap-2 items-start ${compact ? 'bg-white dark:bg-zinc-900 rounded-lg p-2 border border-zinc-100 dark:border-zinc-800' : 'bg-zinc-50 dark:bg-zinc-900 rounded-xl p-3'}`}>
          {/* A picker, not a free-text code: "EN", "en-GB" and "eng" typed by
              hand used to land as three different languages. */}
          <select
            value={tr.lang}
            onChange={e => update(idx, 'lang', e.target.value)}
            title={t('common.languageCodeHint')}
            className={`w-28 shrink-0 border-none bg-zinc-50 dark:bg-zinc-900 rounded-lg px-2 font-bold focus:ring-2 focus:ring-primary/20 ${compact ? 'py-1.5 text-xs' : 'py-2 text-sm'}`}
          >
            <option value="" disabled>—</option>
            {tr.lang && !languages.some(l => l.code === tr.lang) && <option value={tr.lang}>{tr.lang}</option>}
            {languages.map(l => (
              <option key={l.code} value={l.code} disabled={l.code !== tr.lang && translations.some(o => o.lang === l.code)}>{l.label}</option>
            ))}
          </select>
          <div className="flex-1 space-y-1.5">
            {showTitleDescription && (
              <>
                <input
                  type="text" value={tr.title || ''}
                  onChange={e => update(idx, 'title', e.target.value)}
                  placeholder={resolvedTitleLabel}
                  className={`w-full border-none bg-zinc-50 dark:bg-zinc-900 rounded-lg px-2 focus:ring-2 focus:ring-primary/20 ${compact ? 'py-1.5 text-xs' : 'py-2 text-sm'}`}
                />
                <textarea
                  value={tr.description || ''}
                  onChange={e => update(idx, 'description', e.target.value)}
                  placeholder={resolvedDescriptionLabel}
                  className={`w-full border-none bg-zinc-50 dark:bg-zinc-900 rounded-lg px-2 resize-none focus:ring-2 focus:ring-primary/20 ${compact ? 'py-1.5 text-xs min-h-[32px]' : 'py-2 text-sm min-h-[50px]'}`}
                />
              </>
            )}
            {notesLabel !== undefined && (
              <textarea
                value={tr.notes || ''}
                onChange={e => update(idx, 'notes', e.target.value)}
                placeholder={notesLabel}
                className={`w-full border-none bg-zinc-50 dark:bg-zinc-900 rounded-lg px-2 resize-none focus:ring-2 focus:ring-primary/20 ${compact ? 'py-1.5 text-xs min-h-[32px]' : 'py-2 text-sm min-h-[50px]'}`}
              />
            )}
          </div>
          <button
            type="button" onClick={() => remove(idx)}
            className="shrink-0 w-7 h-7 rounded-full bg-red-50 text-red-400 flex items-center justify-center hover:bg-red-100"
          >
            <span className="material-symbols-outlined text-sm">delete</span>
          </button>
        </div>
      ))}
      <button
        type="button" onClick={add}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-lg text-xs font-bold hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
      >
        <span className="material-symbols-outlined text-sm">add</span> {t('common.addTranslation')}
      </button>
    </div>
  );
}
