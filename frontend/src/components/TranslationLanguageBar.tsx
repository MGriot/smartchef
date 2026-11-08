import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface LanguageOption { code: string; label: string }

/**
 * The recipe editor's "which language am I editing" switch. One chip for
 * the language the recipe is written in, one per translation it has, and
 * "+ Language" to start another — so editing the English version of a
 * recipe is one tap, not a free-text "en" typed into a dozen lists.
 */
export default function TranslationLanguageBar({
  baseLang, active, langs, languages, progress, onSelect, onAdd, onRemove, onAiFill, aiBusy,
}: {
  baseLang: string;
  /** null = the original language. */
  active: string | null;
  langs: string[];
  languages: LanguageOption[];
  progress: (lang: string) => { done: number; total: number };
  onSelect: (lang: string | null) => void;
  onAdd: (lang: string) => void;
  onRemove: (lang: string) => void;
  /** Present only where AI translation is available (standalone). */
  onAiFill?: (lang: string) => void;
  aiBusy?: boolean;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const label = (code: string) => languages.find((l) => l.code === code)?.label ?? code.toUpperCase();
  const addable = languages.filter((l) => l.code !== baseLang && !langs.includes(l.code));
  const chip = (selected: boolean) =>
    `flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
      selected ? 'bg-primary text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
    }`;

  return (
    <div className="max-w-7xl mx-auto px-6 pt-6">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
        <span className="mr-1 flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          <span className="material-symbols-outlined text-[18px]">translate</span>
          {t('recipeDetail.editLang.editing')}
        </span>
        <button type="button" className={chip(active === null)} onClick={() => onSelect(null)} aria-pressed={active === null}>
          {label(baseLang)}
          <span className={`text-[9px] font-black uppercase ${active === null ? 'text-white/80' : 'text-zinc-400'}`}>{t('recipeDetail.originalLanguage')}</span>
        </button>
        {langs.map((code) => {
          const { done, total } = progress(code);
          return (
            <button key={code} type="button" className={chip(active === code)} onClick={() => onSelect(code)} aria-pressed={active === code}>
              {label(code)}
              <span className={`tabular-nums text-[10px] ${active === code ? 'text-white/80' : done < total ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-400'}`}>
                {done}/{total}
              </span>
            </button>
          );
        })}
        {adding ? (
          <select
            autoFocus
            defaultValue=""
            onBlur={() => setAdding(false)}
            onChange={(e) => { if (e.target.value) { onAdd(e.target.value); setAdding(false); } }}
            className="rounded-full border-none bg-zinc-50 dark:bg-zinc-800 px-3 py-1.5 text-xs font-bold focus:ring-2 focus:ring-primary/20"
          >
            <option value="" disabled>{t('recipeDetail.editLang.pick')}</option>
            {addable.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        ) : addable.length > 0 && (
          <button type="button" className={chip(false)} onClick={() => setAdding(true)}>
            <span className="material-symbols-outlined text-[16px]">add</span>
            {t('recipeDetail.editLang.add')}
          </button>
        )}
        {active !== null && (
          <span className="ml-auto flex items-center gap-2">
            {onAiFill && (
              <button
                type="button"
                disabled={aiBusy}
                onClick={() => onAiFill(active)}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-[16px] ${aiBusy ? 'animate-spin' : ''}`}>{aiBusy ? 'progress_activity' : 'auto_awesome'}</span>
                {t('recipeDetail.editLang.aiFill')}
              </button>
            )}
            <button
              type="button"
              onClick={() => { if (window.confirm(t('recipeDetail.editLang.removeConfirm', { lang: label(active) }))) onRemove(active); }}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
            >
              <span className="material-symbols-outlined text-[16px]">delete</span>
              {t('recipeDetail.editLang.remove')}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
