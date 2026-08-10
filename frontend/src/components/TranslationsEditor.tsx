import React from 'react';

export interface TranslationEntry {
  lang: string;
  title?: string;
  description?: string;
}

interface TranslationsEditorProps {
  translations: TranslationEntry[];
  onChange: (translations: TranslationEntry[]) => void;
  titleLabel?: string;
  descriptionLabel?: string;
  compact?: boolean;
}

/**
 * Add/remove a list of {lang, title, description} translation entries.
 * Same pattern as the ad hoc translations list in LibraryIngredients.tsx,
 * componentized since recipes need it at two levels (recipe + each step).
 */
export default function TranslationsEditor({
  translations, onChange, titleLabel = 'Title', descriptionLabel = 'Description', compact = false,
}: TranslationsEditorProps) {
  const update = (idx: number, field: keyof TranslationEntry, value: string) =>
    onChange(translations.map((t, i) => i === idx ? { ...t, [field]: value } : t));

  const add = () => onChange([...translations, { lang: '', title: '', description: '' }]);
  const remove = (idx: number) => onChange(translations.filter((_, i) => i !== idx));

  return (
    <div className="space-y-2">
      {translations.map((t, idx) => (
        <div key={idx} className={`flex gap-2 items-start ${compact ? 'bg-white rounded-lg p-2 border border-zinc-100' : 'bg-zinc-50 rounded-xl p-3'}`}>
          <input
            type="text" value={t.lang}
            onChange={e => update(idx, 'lang', e.target.value)}
            placeholder="lang"
            title="Language code, e.g. it"
            className={`w-16 shrink-0 border-none bg-zinc-50 rounded-lg px-2 font-bold focus:ring-2 focus:ring-primary/20 ${compact ? 'py-1.5 text-xs' : 'py-2 text-sm'}`}
          />
          <div className="flex-1 space-y-1.5">
            <input
              type="text" value={t.title || ''}
              onChange={e => update(idx, 'title', e.target.value)}
              placeholder={titleLabel}
              className={`w-full border-none bg-zinc-50 rounded-lg px-2 focus:ring-2 focus:ring-primary/20 ${compact ? 'py-1.5 text-xs' : 'py-2 text-sm'}`}
            />
            <textarea
              value={t.description || ''}
              onChange={e => update(idx, 'description', e.target.value)}
              placeholder={descriptionLabel}
              className={`w-full border-none bg-zinc-50 rounded-lg px-2 resize-none focus:ring-2 focus:ring-primary/20 ${compact ? 'py-1.5 text-xs min-h-[32px]' : 'py-2 text-sm min-h-[50px]'}`}
            />
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
        className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 text-zinc-600 rounded-lg text-xs font-bold hover:bg-zinc-200 transition-colors"
      >
        <span className="material-symbols-outlined text-sm">add</span> Add translation
      </button>
    </div>
  );
}
