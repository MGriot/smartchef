import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface RecipeSourceEntry {
  type: 'url' | 'book' | 'video' | 'other';
  label?: string;
  url?: string;
}

interface RecipeSourcesEditorProps {
  sources: RecipeSourceEntry[];
  onChange: (sources: RecipeSourceEntry[]) => void;
}

export const SOURCE_TYPE_META: Record<RecipeSourceEntry['type'], { labelKey: string; icon: string }> = {
  url: { labelKey: 'editors.sourceTypeUrl', icon: 'link' },
  book: { labelKey: 'editors.sourceTypeBook', icon: 'menu_book' },
  video: { labelKey: 'editors.sourceTypeVideo', icon: 'play_circle' },
  other: { labelKey: 'editors.sourceTypeOther', icon: 'bookmark' },
};

/**
 * Add/remove one or more source references for a recipe — a link, a book
 * citation, a video, or anything else — distinct from the single
 * LLM-import `sourceUrl` field.
 */
export default function RecipeSourcesEditor({ sources, onChange }: RecipeSourcesEditorProps) {
  const { t } = useTranslation();
  const [draftType, setDraftType] = useState<RecipeSourceEntry['type']>('url');
  const [draftLabel, setDraftLabel] = useState('');
  const [draftUrl, setDraftUrl] = useState('');

  const addSource = () => {
    const label = draftLabel.trim();
    const url = draftUrl.trim();
    if (!label && !url) return;
    onChange([...sources, { type: draftType, label: label || undefined, url: url || undefined }]);
    setDraftType('url');
    setDraftLabel('');
    setDraftUrl('');
  };

  const removeSource = (idx: number) => onChange(sources.filter((_, i) => i !== idx));

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3 items-end">
        <div>
          <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.sourceType')}</label>
          <select
            value={draftType}
            onChange={e => setDraftType(e.target.value as RecipeSourceEntry['type'])}
            className="px-3 py-2.5 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-primary/20 text-sm font-medium"
          >
            {(Object.keys(SOURCE_TYPE_META) as RecipeSourceEntry['type'][]).map(type => (
              <option key={type} value={type}>{t(SOURCE_TYPE_META[type].labelKey)}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[140px]">
          <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.sourceLabel')}</label>
          <input
            type="text" value={draftLabel}
            onChange={e => setDraftLabel(e.target.value)}
            placeholder={draftType === 'book' ? t('editors.sourceLabelBookPlaceholder') : t('editors.sourceLabelPlaceholder')}
            className="w-full px-3 py-2.5 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-primary/20 text-sm font-medium"
          />
        </div>
        <div className="flex-1 min-w-[140px]">
          <label className="block text-[9px] uppercase font-bold text-zinc-400 dark:text-zinc-500 mb-1">{t('editors.sourceUrl')}</label>
          <input
            type="url" value={draftUrl}
            onChange={e => setDraftUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSource(); } }}
            placeholder={t('editors.urlPlaceholder')}
            className="w-full px-3 py-2.5 bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 focus:ring-2 focus:ring-primary/20 text-sm font-medium"
          />
        </div>
        <button
          type="button" onClick={addSource}
          disabled={!draftLabel.trim() && !draftUrl.trim()}
          className="w-10 h-10 rounded-xl bg-zinc-900 text-white flex items-center justify-center disabled:opacity-30 shrink-0"
        >
          <span className="material-symbols-outlined text-lg">add</span>
        </button>
      </div>
      {sources.length > 0 && (
        <div className="space-y-2">
          {sources.map((s, idx) => {
            const meta = SOURCE_TYPE_META[s.type] || SOURCE_TYPE_META.other;
            return (
              <div key={idx} className="flex items-center gap-3 px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 rounded-xl border border-zinc-100 dark:border-zinc-800">
                <span className="material-symbols-outlined text-primary text-lg shrink-0">{meta.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-zinc-700 dark:text-zinc-300 truncate">{s.label || s.url || t(meta.labelKey)}</p>
                  {s.url && s.label && <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{s.url}</p>}
                </div>
                <button
                  type="button" onClick={() => removeSource(idx)}
                  className="w-7 h-7 rounded-full bg-red-50 text-red-400 flex items-center justify-center hover:bg-red-100 shrink-0"
                >
                  <span className="material-symbols-outlined text-sm">delete</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
